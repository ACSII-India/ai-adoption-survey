<#
  Outlook side of the automatic job. Run on the Windows PC that has Outlook,
  every 15 minutes (Task Scheduler). It:
    1. fetches new items from the Linux outbox over SSH (assessment/outbox/pending/),
    2. for each item creates the email (the "result is ready" notice with the
       personal link; an attachment only if the item has one) and
         - SENDS it only when the item says "send" AND this script was started with -AllowSend,
         - otherwise saves it as a DRAFT in Outlook,
    3. reports back (receipt.json) and moves the item to outbox/done/ on Linux.

  One-time setup (PowerShell, as yourself):
    ssh-keygen -t ed25519                                   # press Enter for the defaults
    type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh sdj29@sdj29-desktop-1 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
    ssh -o BatchMode=yes sdj29@sdj29-desktop-1 echo ok      # must print ok without asking for a password

  Run once by hand (drafts only):
    powershell -ExecutionPolicy Bypass -File .\outlook-outbox.ps1
  Allow sending (only after the decision to share reports):
    powershell -ExecutionPolicy Bypass -File .\outlook-outbox.ps1 -AllowSend
#>
param(
  [string]$LinuxHost = "sdj29-desktop-1",
  [string]$LinuxUser = "sdj29",
  [string]$RemoteDir = "PROJECTS/ai-adoption-survey/assessment/outbox",
  [string]$LocalDir = "$env:LOCALAPPDATA\AIAssessmentOutbox",
  [switch]$AllowSend
)
$ErrorActionPreference = "Stop"
$target = "$LinuxUser@$LinuxHost"
New-Item -ItemType Directory -Force -Path "$LocalDir\inbox" | Out-Null
$logFile = Join-Path $LocalDir "outbox.log"
$processed = Join-Path $LocalDir "processed.txt"
if (-not (Test-Path $processed)) { New-Item -ItemType File -Path $processed | Out-Null }
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; Write-Host $line; Add-Content -Path $logFile -Value $line -Encoding UTF8 }

# 1. What is waiting on Linux?
$ids = & ssh -o BatchMode=yes -o ConnectTimeout=20 $target "ls -1 $RemoteDir/pending 2>/dev/null"
if ($LASTEXITCODE -ne 0 -and -not $ids) { Log "ERROR cannot reach $target over SSH (see setup in this script)"; exit 1 }
$done = Get-Content $processed
$ids = @($ids | Where-Object { $_ -and ($done -notcontains $_) })
if (-not $ids.Count) { Log "OK nothing new"; exit 0 }

$outlook = New-Object -ComObject Outlook.Application
$session = $outlook.Session

foreach ($id in $ids) {
  try {
    $local = Join-Path "$LocalDir\inbox" $id
    if (Test-Path $local) { Remove-Item -Recurse -Force $local }
    & scp -o BatchMode=yes -r "${target}:$RemoteDir/pending/$id" "$LocalDir\inbox\" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "scp failed" }
    $item = Get-Content (Join-Path $local "item.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    $body = Join-Path $local "body.html"
    $pdf = if ($item.attachment) { Join-Path $local $item.attachment } else { "" }
    if (-not $item.email) { throw "no email address" }
    if ($pdf -and -not (Test-Path $pdf)) { throw "attachment missing ($($item.attachment))" }

    $mail = $outlook.CreateItem(0)
    $mail.To = $item.email
    if ($item.cc) { $mail.CC = $item.cc }
    $mail.Subject = $item.subject
    $mail.HTMLBody = [System.IO.File]::ReadAllText($body, [System.Text.Encoding]::UTF8)
    if ($pdf) { [void]$mail.Attachments.Add($pdf) }   # the "result is ready" notice has no attachment
    if ($item.fromMailbox) {
      $account = $null
      foreach ($a in $session.Accounts) { if ($a.SmtpAddress -eq $item.fromMailbox) { $account = $a } }
      if ($account) { $mail.SendUsingAccount = $account } else { $mail.SentOnBehalfOfName = $item.fromMailbox }
    }
    if ($item.action -eq "send" -and $AllowSend) { $mail.Send(); $status = "sent" }
    else { $mail.Save(); $status = "drafted" }

    # 3. Report back and move the item to done/ on Linux.
    $receipt = @{ status = $status; at = (Get-Date).ToString("s"); reason = $(if ($status -eq "drafted" -and $item.action -eq "send") { "sending not allowed on this PC (-AllowSend not set)" } else { $item.reason }) } | ConvertTo-Json
    $rfile = Join-Path $local "receipt.json"
    [System.IO.File]::WriteAllText($rfile, $receipt, (New-Object System.Text.UTF8Encoding $false))
    & scp -o BatchMode=yes $rfile "${target}:$RemoteDir/pending/$id/receipt.json" | Out-Null
    & ssh -o BatchMode=yes $target "mkdir -p $RemoteDir/done && mv $RemoteDir/pending/$id $RemoteDir/done/"
    Add-Content -Path $processed -Value $id -Encoding UTF8
    Log "$($status.ToUpper()) $($item.empId) to $($item.email) (item said: $($item.action))"
  } catch {
    Log "ERROR $id : $($_.Exception.Message)"
  }
}
