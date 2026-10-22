[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Assert-NativeSuccess([string]$Operation) {
  if ($LASTEXITCODE -ne 0) {
    throw "$Operation failed with exit code $LASTEXITCODE"
  }
}

$workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$wrangler = [System.IO.Path]::GetFullPath(
  (Join-Path $workspace "node_modules/wrangler/bin/wrangler.js")
)
$config = [System.IO.Path]::GetFullPath(
  (Join-Path $PSScriptRoot "wrangler.hyperdrive-probe.jsonc")
)
$suffix = [guid]::NewGuid().ToString("N").Substring(0, 12)
$workerName = "jpgr-hyperdrive-probe-$suffix"
$tokenBytes = [byte[]]::new(32)
$randomNumberGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $randomNumberGenerator.GetBytes($tokenBytes)
} finally {
  $randomNumberGenerator.Dispose()
}
$probeToken = [Convert]::ToBase64String($tokenBytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
$deployed = $false

try {
  $deployOutput = & node $wrangler deploy `
    --config $config `
    --name $workerName `
    --var "PROBE_TOKEN:$probeToken" 2>&1 | Out-String
  Assert-NativeSuccess "deploying the temporary Hyperdrive probe"
  $deployed = $true

  $urlMatch = [regex]::Match($deployOutput, "https://[a-zA-Z0-9.-]+\.workers\.dev")
  if (-not $urlMatch.Success) {
    throw "Wrangler did not report a workers.dev URL for the temporary probe"
  }
  $url = $urlMatch.Value
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  $health = $null
  do {
    try {
      $health = Invoke-RestMethod `
        -Uri $url `
        -Headers @{ Authorization = "Bearer $probeToken" } `
        -TimeoutSec 15
    } catch {
      $errorBody = $_.ErrorDetails.Message
      if ($errorBody) {
        try {
          $failedHealth = $errorBody | ConvertFrom-Json
          if ($failedHealth.backend -eq "postgres") {
            throw "Hyperdrive probe query failed: $errorBody"
          }
        } catch [System.ArgumentException] {
          # A new workers.dev route can briefly return a non-JSON 404 while it
          # propagates. Keep polling within the hard deadline.
        }
      }
      Start-Sleep -Seconds 2
    }
  } while (-not $health -and [DateTime]::UtcNow -lt $deadline)
  if (-not $health) {
    throw "The temporary workers.dev probe route did not become healthy within 60 seconds"
  }
  if (-not $health.ok -or $health.backend -ne "postgres") {
    throw "Unexpected Hyperdrive probe response: $($health | ConvertTo-Json -Compress)"
  }
  $health | ConvertTo-Json -Compress
} catch {
  if ($_.ErrorDetails.Message) {
    Write-Error "$($_.Exception.Message)`n$($_.ErrorDetails.Message)"
  } else {
    Write-Error $_
  }
} finally {
  if ($deployed) {
    & node $wrangler delete $workerName --config $config --force | Out-Null
    Assert-NativeSuccess "deleting the temporary Hyperdrive probe"
  }
  [Array]::Clear($tokenBytes, 0, $tokenBytes.Length)
  $probeToken = $null
}
