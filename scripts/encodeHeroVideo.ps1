# Encodes the hero clip(s) into web-sized WebM (VP9) + MP4 (H.264) and extracts the last frame as a poster.
#
#   powershell -ExecutionPolicy Bypass -File scripts/encodeHeroVideo.ps1
#     → public/videos/burger.mp4         → burger.min.webm, burger.min.mp4, burger-poster.jpg
#     → public/videos/burger-mobile.mp4  → burger-mobile.min.* + burger-mobile-poster.jpg (if present)
#
#   Single clip: -Source path/to/clip.mp4 -Name burger [-MaxWidth 1600] [-PosterAt 4.2]
#   Use -PosterAt with the same time as CONFIG.holdAt in js/heroVideo.js if you freeze before the end.
param(
    [string]$Source,
    [string]$Name = 'burger',
    [int]$MaxWidth = 1600,
    [string]$OutDir = 'public/videos',
    [double]$MaxMB = 2,
    [double]$PosterAt = -1
)

$ErrorActionPreference = 'Stop'

function Find-Tool([string]$tool) {
    $cmd = Get-Command $tool -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $winget = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\$tool.exe"
    if (Test-Path $winget) { return $winget }
    throw "$tool not found. Install it with: winget install Gyan.FFmpeg"
}
$ffmpeg = Find-Tool 'ffmpeg'
$ffprobe = Find-Tool 'ffprobe'

function Invoke-FFmpeg([string[]]$ffArgs) {
    & $ffmpeg -hide_banner -loglevel error -y @ffArgs
    if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed: $($ffArgs -join ' ')" }
}

# Files written straight into the project folder sometimes hit transient locks (antivirus scans),
# so everything is encoded in a temp folder and moved over with retries.
function Publish-File([string]$from, [string]$to) {
    for ($i = 1; $i -le 10; $i++) {
        try { Move-Item -Force $from $to; return } catch { Start-Sleep -Milliseconds (300 * $i) }
    }
    throw "Could not write $to (file locked?)"
}

function Encode-Clip([string]$src, [string]$name, [int]$maxWidth) {
    if (-not (Test-Path $src)) { throw "Source clip not found: $src" }
    New-Item -ItemType Directory -Force $OutDir | Out-Null
    $work = Join-Path ([IO.Path]::GetTempPath()) "encodeHeroVideo-$name"
    New-Item -ItemType Directory -Force $work | Out-Null

    $duration = [double]::Parse((& $ffprobe -v error -show_entries format=duration -of csv=p=0 $src), [Globalization.CultureInfo]::InvariantCulture)
    $maxBytes = [long]($MaxMB * 1MB)

    # Aim ~15% under the cap; container overhead and 2-pass drift land the rest.
    $startKbps = [math]::Floor($maxBytes * 0.85 * 8 / 1000 / $duration)

    # VP9: two-pass constrained quality (-b:v is the ceiling).
    # H.264: single-pass CRF capped by VBV — x264's two-pass can badly misallocate on grainy clips.
    $targets = @(
        @{
            File = "$name.min.webm"; Ratio = 0.8; TwoPass = $true
            Codec = @('-c:v', 'libvpx-vp9', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-pix_fmt', 'yuv420p', '-crf', '32')
            Rate = { param($k) @('-b:v', "${k}k") }
        },
        @{
            File = "$name.min.mp4"; Ratio = 1.0; TwoPass = $false
            Codec = @('-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-tag:v', 'avc1', '-crf', '23')
            Rate = { param($k) @('-maxrate', "${k}k", '-bufsize', "$($k * 2)k") }
        }
    )

    foreach ($t in $targets) {
        $out = Join-Path $work $t.File
        $passlog = Join-Path $work "$($t.File).pass"
        $kbps = [math]::Floor($startKbps * $t.Ratio)
        $width = $maxWidth
        $denoise = $false
        # Escalation when a noisy clip won't fit: lower bitrate → mild denoise → smaller frame.
        for ($attempt = 1; $attempt -le 6; $attempt++) {
            $vf = "scale='min($width,iw)':-2"
            if ($denoise) { $vf = "hqdn3d=3:3:6:6,$vf" }
            Get-ChildItem "$passlog*" -ErrorAction SilentlyContinue | Remove-Item -Force
            $common = @('-i', $src, '-vf', $vf) + $t.Codec + (& $t.Rate $kbps) + @('-an')
            if ($t.TwoPass) {
                Invoke-FFmpeg ($common + @('-passlogfile', $passlog, '-pass', '1', '-f', 'null', 'NUL'))
                Invoke-FFmpeg ($common + @('-passlogfile', $passlog, '-pass', '2', $out))
            } else {
                Invoke-FFmpeg ($common + @($out))
            }
            $size = (Get-Item $out).Length
            if ($size -le $maxBytes) { break }
            Write-Host ("  {0}: {1:N2} MB at {2} kbps / {3}px - over budget, retrying" -f $t.File, ($size / 1MB), $kbps, $width)
            if ($attempt -eq 2) { $denoise = $true }
            elseif ($attempt -ge 3) { $width = [math]::Floor($width * 0.8 / 2) * 2 }
            else { $kbps = [math]::Floor($kbps * 0.8) }
        }
        Get-ChildItem "$passlog*" -ErrorAction SilentlyContinue | Remove-Item -Force
        $size = (Get-Item $out).Length
        Publish-File $out (Join-Path $OutDir $t.File)
        $flag = if ($size -gt $maxBytes) { '  ! still over budget' } else { '' }
        Write-Host ("{0,-28} {1,6:N2} MB  ({2} kbps, {3}px{4}){5}" -f $t.File, ($size / 1MB), $kbps, $width, $(if ($denoise) { ', denoised' } else { '' }), $flag)
    }

    $poster = Join-Path $work "$name-poster.jpg"
    $scale = "scale='min($maxWidth,iw)':-2"
    if ($PosterAt -ge 0) {
        Invoke-FFmpeg @('-ss', "$PosterAt", '-i', $src, '-vf', $scale, '-frames:v', '1', '-q:v', '3', $poster)
    } else {
        # -update 1 keeps overwriting the image, so the file ends up holding the very last frame.
        Invoke-FFmpeg @('-sseof', '-0.5', '-i', $src, '-vf', $scale, '-update', '1', '-q:v', '3', $poster)
    }
    $size = (Get-Item $poster).Length
    Publish-File $poster (Join-Path $OutDir "$name-poster.jpg")
    Write-Host ("{0,-28} {1,6:N2} MB" -f "$name-poster.jpg", ($size / 1MB))
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}

if ($Source) {
    Encode-Clip $Source $Name $MaxWidth
} else {
    Encode-Clip (Join-Path $OutDir 'burger.mp4') 'burger' 1600
    $mobile = Join-Path $OutDir 'burger-mobile.mp4'
    if (Test-Path $mobile) {
        Encode-Clip $mobile 'burger-mobile' 1080
        Write-Host "Mobile clip encoded - set CONFIG.sources.mobile in js/heroVideo.js."
    }
}
