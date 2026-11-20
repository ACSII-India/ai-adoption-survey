<#
  Creates one Outlook DRAFT per person from "Send list.csv", with their
  one-page PDF attached. It never sends anything: drafts are saved in your
  Outlook Drafts folder for you to check. Sending is a separate, later step.

  Run on the Windows PC that has Outlook, from a copy of the assessment
  "out" folder (it must contain Send list.csv, the emails\ and pdf\ folders):

    powershell -ExecutionPolicy Bypass -File .\create-outlook-drafts.ps1 -Only someone@company.org
    powershell -ExecutionPolicy Bypass -File .\create-outlook-drafts.ps1 -Limit 5
    powershell -ExecutionPolicy Bypass -File .\create-outlook-drafts.ps1

  -Only   create a draft for this one email address (a test)
  -Limit  create drafts for the first N rows only
#>
param(
  [string]$Only = "",
  [int]$Limit = 0
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$list = Join-Path $here "Send list.csv"
if (-not (Test-Path $list)) { throw "Send list.csv not found next to this script ($here)." }

$rows = Import-Csv -Path $list -Encoding UTF8
if ($Only) { $rows = $rows | Where-Object { $_.Email -eq $Only } }
if ($Limit -gt 0) { $rows = $rows | Select-Object -First $Limit }
if (-not $rows) { Write-Host "No matching rows."; exit 0 }

$outlook = New-Object -ComObject Outlook.Application
$session = $outlook.Session
$made = 0; $skipped = @()

foreach ($r in $rows) {
  $body = Join-Path $here $r.'Body file'
  $pdf = if ($r.Attachment) { Join-Path $here $r.Attachment } else { "" }
  if (-not $r.Email) { $skipped += "$($r.Name): no email address"; continue }
  if (-not (Test-Path $body)) { $skipped += "$($r.Email): body file missing ($body)"; continue }
  if (-not $pdf -or -not (Test-Path $pdf)) { $skipped += "$($r.Email): PDF missing"; continue }

  $mail = $outlook.CreateItem(0)
  $mail.To = $r.Email
  if ($r.Cc) { $mail.CC = $r.Cc }
  $mail.Subject = $r.Subject
  $mail.HTMLBody = [System.IO.File]::ReadAllText($body, [System.Text.Encoding]::UTF8)
  [void]$mail.Attachments.Add($pdf)
  if ($r.'From mailbox') {
    $account = $null
    foreach ($a in $session.Accounts) { if ($a.SmtpAddress -eq $r.'From mailbox') { $account = $a } }
    if ($account) { $mail.SendUsingAccount = $account } else { $mail.SentOnBehalfOfName = $r.'From mailbox' }
  }
  $mail.Save()   # saved as a draft only
  $made++
}

Write-Host "Drafts created: $made (in your Outlook Drafts folder). Nothing was sent."
if ($skipped.Count) { Write-Host "Skipped:"; $skipped | ForEach-Object { Write-Host "  - $_" } }
