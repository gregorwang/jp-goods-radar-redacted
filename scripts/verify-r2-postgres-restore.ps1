[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ObjectKey,
  [string]$VpsHost = "203.0.113.10",
  [string]$Bucket = "jpgr-postgres-backups"
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Assert-NativeSuccess([string]$Operation) {
  if ($LASTEXITCODE -ne 0) {
    throw "$Operation failed with exit code $LASTEXITCODE"
  }
}

function Read-BackupPassphrase([string]$SecretPath) {
  if (-not (Test-Path -LiteralPath $SecretPath)) {
    throw "Backup key not found at $SecretPath"
  }
  $encrypted = (Get-Content -LiteralPath $SecretPath -Raw).Trim()
  $securePassphrase = ConvertTo-SecureString -String $encrypted
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassphrase)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

if ($ObjectKey -notmatch "^daily/[0-9]{4}/[0-9]{2}/jpgr-[0-9]{8}T[0-9]{6}Z[.]dump[.]gpg$") {
  throw "Refusing unexpected backup object key: $ObjectKey"
}

$workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$wrangler = [System.IO.Path]::GetFullPath(
  (Join-Path $workspace "node_modules/wrangler/bin/wrangler.js")
)
$profileDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
$secretPath = Join-Path $profileDirectory ".jpgr/postgres-backup-passphrase.dpapi"
$passphrase = Read-BackupPassphrase $secretPath
$timestamp = [DateTime]::UtcNow.ToString("yyyyMMddHHmmss")
$restoreDatabase = "jpgr_restore_$timestamp"
$remoteDirectory = "/var/backups/jpgr-restore-$timestamp"
if (
  $restoreDatabase -notmatch "^jpgr_restore_[0-9]{14}$" `
  -or $remoteDirectory -notmatch "^/var/backups/jpgr-restore-[0-9]{14}$"
) {
  throw "Refusing unsafe restore target"
}

$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempDirectory = [System.IO.Path]::GetFullPath(
  (Join-Path $tempRoot "jpgr-restore-$([guid]::NewGuid().ToString("N"))")
)
if (-not $tempDirectory.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing unsafe local temporary directory: $tempDirectory"
}
New-Item -ItemType Directory -Path $tempDirectory | Out-Null
$encryptedPath = Join-Path $tempDirectory "backup.dump.gpg"
$manifestPath = Join-Path $tempDirectory "manifest.json"
$remoteEncrypted = "$remoteDirectory/backup.dump.gpg"
$remoteDump = "$remoteDirectory/backup.dump"
$sshOptions = @("-o", "BatchMode=yes", "-o", "ConnectTimeout=15")
$remoteDirectoryCreated = $false

try {
  & node $wrangler r2 object get "$Bucket/$ObjectKey.manifest.json" `
    --remote --file $manifestPath
  Assert-NativeSuccess "downloading the backup manifest"
  & node $wrangler r2 object get "$Bucket/$ObjectKey" --remote --file $encryptedPath
  Assert-NativeSuccess "downloading the encrypted backup"

  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.objectKey -ne $ObjectKey -or $manifest.sha256 -notmatch "^[0-9a-f]{64}$") {
    throw "The R2 manifest does not describe the requested backup"
  }
  $downloadSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $encryptedPath).Hash.ToLowerInvariant()
  if ($downloadSha256 -ne $manifest.sha256) {
    throw "The downloaded backup does not match its manifest"
  }

  & ssh @sshOptions "root@$VpsHost" `
    "install -d -o postgres -g postgres -m 700 '$remoteDirectory'"
  Assert-NativeSuccess "creating the isolated restore directory"
  $remoteDirectoryCreated = $true
  & scp @sshOptions $encryptedPath "root@${VpsHost}:$remoteEncrypted"
  Assert-NativeSuccess "copying the encrypted backup to the VPS"

  $restoreCommand = @(
    "set -euo pipefail"
    "umask 077"
    "exec 3<&0"
    "gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 --output '$remoteDump' --decrypt '$remoteEncrypted'"
    "chown postgres:postgres '$remoteDump'"
    "chmod 600 '$remoteDump'"
    "sudo -u postgres createdb --template=template0 '$restoreDatabase'"
    "sudo -u postgres pg_restore --exit-on-error --no-owner --no-privileges --dbname='$restoreDatabase' '$remoteDump'"
  ) -join "; "
  $passphrase | & ssh @sshOptions "root@$VpsHost" $restoreCommand
  Assert-NativeSuccess "restoring the isolated PostgreSQL database"

  $evidenceQuery = @"
SELECT json_build_object(
  'radar_core_tables',
  (SELECT count(*) FROM information_schema.tables
   WHERE table_schema='radar_core' AND table_type='BASE TABLE'),
  'radar_analytics_tables',
  (SELECT count(*) FROM information_schema.tables
   WHERE table_schema='radar_analytics' AND table_type='BASE TABLE'),
  'source_registry_rows',
  (SELECT count(*) FROM radar_core.source_registry),
  'watch_profile_rows',
  (SELECT count(*) FROM radar_core.watch_profiles)
);
"@
  $previousEncoding = $OutputEncoding
  $OutputEncoding = [System.Text.ASCIIEncoding]::new()
  try {
    $restoreEvidence = $evidenceQuery |
      & ssh @sshOptions "root@$VpsHost" `
        "sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d '$restoreDatabase' -Atq"
  } finally {
    $OutputEncoding = $previousEncoding
  }
  Assert-NativeSuccess "querying the isolated PostgreSQL database"
  $parsedEvidence = $restoreEvidence | Select-Object -Last 1 | ConvertFrom-Json
  if (
    [int]$parsedEvidence.radar_core_tables -lt 50 `
    -or [int]$parsedEvidence.radar_analytics_tables -lt 20 `
    -or [int]$parsedEvidence.source_registry_rows -lt 1
  ) {
    throw "The restored database is missing expected schemas or core rows"
  }

  [pscustomobject]@{
    bucket = $Bucket
    objectKey = $ObjectKey
    sha256 = $downloadSha256
    restoreDatabase = $restoreDatabase
    restore = "passed"
    evidence = $parsedEvidence
  } | ConvertTo-Json -Depth 4
} finally {
  $passphrase = $null
  if ($remoteDirectoryCreated) {
    & ssh @sshOptions "root@$VpsHost" `
      "sudo -u postgres dropdb --if-exists --force '$restoreDatabase'; rm -rf -- '$remoteDirectory'" |
      Out-Null
  }
  $safeTemporaryPath = (Test-Path -LiteralPath $tempDirectory) `
    -and $tempDirectory.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) `
    -and ([System.IO.Path]::GetFileName($tempDirectory) -like "jpgr-restore-*")
  if ($safeTemporaryPath) {
    Remove-Item -LiteralPath $tempDirectory -Recurse -Force
  }
}
