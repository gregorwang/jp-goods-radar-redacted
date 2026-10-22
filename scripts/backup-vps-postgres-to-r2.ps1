[CmdletBinding()]
param(
  [string]$VpsHost = "203.0.113.10",
  [string]$Database = "jpgr",
  [string]$Bucket = "jpgr-postgres-backups"
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Assert-NativeSuccess([string]$Operation) {
  if ($LASTEXITCODE -ne 0) {
    throw "$Operation failed with exit code $LASTEXITCODE"
  }
}

function Set-PrivateDirectoryAcl([string]$Path) {
  $account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls.exe $Path "/inheritance:r" "/grant:r" "${account}:(OI)(CI)F" | Out-Null
  Assert-NativeSuccess "protecting the local backup key directory"
}

function Read-BackupPassphrase([string]$SecretPath) {
  if (-not (Test-Path -LiteralPath $SecretPath)) {
    $bytes = New-Object byte[] 32
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
      $generator.GetBytes($bytes)
    } finally {
      $generator.Dispose()
    }
    $generated = [Convert]::ToBase64String($bytes)
    $secure = ConvertTo-SecureString -String $generated -AsPlainText -Force
    ConvertFrom-SecureString -SecureString $secure |
      Set-Content -LiteralPath $SecretPath -Encoding ASCII
    [Array]::Clear($bytes, 0, $bytes.Length)
    $generated = $null
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

$workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$wrangler = [System.IO.Path]::GetFullPath((Join-Path $workspace "node_modules/wrangler/bin/wrangler.js"))
if (-not (Test-Path -LiteralPath $wrangler)) {
  throw "Wrangler is not installed at $wrangler"
}

$profileDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
$secretDirectory = Join-Path $profileDirectory ".jpgr"
if (-not (Test-Path -LiteralPath $secretDirectory)) {
  New-Item -ItemType Directory -Path $secretDirectory | Out-Null
}
Set-PrivateDirectoryAcl $secretDirectory
$secretPath = Join-Path $secretDirectory "postgres-backup-passphrase.dpapi"
$passphrase = Read-BackupPassphrase $secretPath

$timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ")
$fileName = "jpgr-$timestamp.dump.gpg"
$remoteDirectory = "/var/backups/jpgr"
$remotePath = "$remoteDirectory/$fileName"
if ($remotePath -notmatch "^/var/backups/jpgr/jpgr-[0-9]{8}T[0-9]{6}Z[.]dump[.]gpg$") {
  throw "Refusing unsafe remote backup path: $remotePath"
}
$objectKey = "daily/$([DateTime]::UtcNow.ToString("yyyy/MM"))/$fileName"

$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempDirectory = [System.IO.Path]::GetFullPath((Join-Path $tempRoot "jpgr-backup-$([guid]::NewGuid().ToString("N"))"))
if (-not $tempDirectory.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing unsafe temporary directory: $tempDirectory"
}
New-Item -ItemType Directory -Path $tempDirectory | Out-Null
$localEncrypted = Join-Path $tempDirectory $fileName
$roundTripEncrypted = Join-Path $tempDirectory "roundtrip-$fileName"
$manifestPath = Join-Path $tempDirectory "$fileName.manifest.json"
$sshOptions = @(
  "-T",
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=15",
  "-o", "ServerAliveInterval=15",
  "-o", "ServerAliveCountMax=4"
)
$sshNoInputOptions = @($sshOptions + "-n")

try {
  & ssh @sshNoInputOptions "root@$VpsHost" "install -d -m 700 '$remoteDirectory'"
  Assert-NativeSuccess "creating the VPS backup directory"

  $dumpCommand = @(
    "set -o pipefail"
    "umask 077"
    "exec 3<&0"
    "sudo -u postgres pg_dump --format=custom --compress=9 --no-owner --no-privileges --dbname='$Database' | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 --symmetric --cipher-algo AES256 --compress-algo none --output '$remotePath'"
  ) -join "; "
  $passphrase | & ssh @sshOptions "root@$VpsHost" $dumpCommand
  Assert-NativeSuccess "creating the encrypted PostgreSQL dump"

  $restoreProbePath = "$remoteDirectory/.restore-check-$timestamp.dump"
  $restoreCheck = @(
    "set -euo pipefail"
    "umask 077"
    "trap 'rm -f -- $restoreProbePath' EXIT"
    "exec 3<&0"
    "gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 --output '$restoreProbePath' --decrypt '$remotePath'"
    "pg_restore --list '$restoreProbePath' >/dev/null"
  ) -join "; "
  $passphrase | & ssh @sshOptions "root@$VpsHost" $restoreCheck
  Assert-NativeSuccess "validating the encrypted dump with pg_restore"

  $metadata = @(& ssh @sshNoInputOptions "root@$VpsHost" "sha256sum '$remotePath' | cut -d' ' -f1; stat -c %s '$remotePath'")
  Assert-NativeSuccess "reading backup metadata"
  if ($metadata.Count -lt 2 -or $metadata[0] -notmatch "^[0-9a-f]{64}$") {
    throw "The VPS returned invalid backup metadata"
  }
  $remoteSha256 = $metadata[0]
  $sizeBytes = [int64]$metadata[1]

  & scp @sshOptions "root@${VpsHost}:$remotePath" $localEncrypted
  Assert-NativeSuccess "copying the encrypted dump off the VPS"
  $localSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $localEncrypted).Hash.ToLowerInvariant()
  if ($localSha256 -ne $remoteSha256) {
    throw "The encrypted dump changed while leaving the VPS"
  }

  & node $wrangler r2 object put "$Bucket/$objectKey" --remote --force `
    --file $localEncrypted --content-type "application/octet-stream"
  Assert-NativeSuccess "uploading the encrypted dump to R2"

  & node $wrangler r2 object get "$Bucket/$objectKey" --remote --file $roundTripEncrypted
  Assert-NativeSuccess "downloading the R2 verification copy"
  $roundTripSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $roundTripEncrypted).Hash.ToLowerInvariant()
  if ($roundTripSha256 -ne $remoteSha256) {
    throw "The R2 round-trip checksum does not match the VPS dump"
  }

  $manifest = [ordered]@{
    version = 1
    database = $Database
    createdAt = [DateTime]::UtcNow.ToString("o")
    objectKey = $objectKey
    sizeBytes = $sizeBytes
    sha256 = $remoteSha256
    archiveFormat = "pg_dump custom"
    encryption = "OpenPGP symmetric AES-256"
    restoreCheck = "pg_restore --list passed"
    keyLocation = $secretPath
  } | ConvertTo-Json
  Set-Content -LiteralPath $manifestPath -Value $manifest -Encoding UTF8
  & node $wrangler r2 object put "$Bucket/$objectKey.manifest.json" --remote --force `
    --file $manifestPath --content-type "application/json"
  Assert-NativeSuccess "uploading the backup manifest"

  [pscustomobject]@{
    bucket = $Bucket
    objectKey = $objectKey
    sizeBytes = $sizeBytes
    sha256 = $remoteSha256
    restoreCheck = "passed"
    roundTripCheck = "passed"
    keyFile = $secretPath
    vpsEncryptedCopy = $remotePath
  } | ConvertTo-Json
} finally {
  $passphrase = $null
  $safeTempPath = (Test-Path -LiteralPath $tempDirectory) -and $tempDirectory.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and ([System.IO.Path]::GetFileName($tempDirectory) -like "jpgr-backup-*")
  if ($safeTempPath) {
    Remove-Item -LiteralPath $tempDirectory -Recurse -Force
  }
}
