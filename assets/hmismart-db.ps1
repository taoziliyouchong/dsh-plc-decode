# hmismart-db.ps1 - attach a copy of a .hmismart (SQL Server MDF) to LocalDB and dump tables.
#
# Why: a .hmismart project file IS a SQL Server database (8192-byte pages, header 01 0F 00 00).
# The screen -> element -> text chain lives in HmiBasicTable.ParentId; texts are in
# HmiTextTable.Language0..31. Reading the binary by hand cannot recover that chain.
#
# The source file is never modified: it is copied to a temp folder first.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File hmismart-db.ps1 -Source <proj.hmismart> -Out <dir> [-Instance WINCCFLEX2022]
#
# ASCII only on purpose: Windows PowerShell 5.1 reads scripts as ANSI unless they carry a
# UTF-8 BOM, so non-ASCII text in this file would break on some hosts.
param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$Instance = "WINCCFLEX2022",
    [int]$TimeoutSec = 900
)
$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Source)) { throw "source not found: $Source" }
$src = (Resolve-Path -LiteralPath $Source).Path
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path -LiteralPath $Out).Path

$fi = Get-Item -LiteralPath $src
$pageOK = ($fi.Length % 8192 -eq 0)

# ---- copy (share-read so a running WinCC does not block us) ----
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("hmimdf_" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$mdf = Join-Path $tmp "project.mdf"
$fsIn = [IO.File]::Open($src, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
$fsOut = [IO.File]::Create($mdf)
try { $fsIn.CopyTo($fsOut, 1048576) } finally { $fsOut.Close(); $fsIn.Close() }
Set-ItemProperty -LiteralPath $mdf -Name IsReadOnly -Value $false -ErrorAction SilentlyContinue

$dbName = "HMIDEC_" + [guid]::NewGuid().ToString("N").Substring(0, 8)
$connected = $false
$conn = $null
$cs = ""

function Write-Tsv([string]$fileName, [string]$sql) {
    $cmd = $conn.CreateCommand(); $cmd.CommandTimeout = $TimeoutSec
    $cmd.CommandText = $sql
    $rd = $cmd.ExecuteReader()
    $lines = New-Object System.Collections.Generic.List[string]
    try {
        $hdr = @(); for ($i = 0; $i -lt $rd.FieldCount; $i++) { $hdr += $rd.GetName($i) }
        $lines.Add(($hdr -join "`t"))
        while ($rd.Read()) {
            $row = @()
            for ($i = 0; $i -lt $rd.FieldCount; $i++) {
                $v = $rd.GetValue($i)
                if ($v -is [byte[]]) { $v = "0x" + [BitConverter]::ToString($v).Replace("-", "").ToLower() }
                elseif ($v -is [datetime]) { $v = $v.ToString("yyyy-MM-dd HH:mm:ss") }
                if ($null -eq $v) { $v = "" }
                $row += (([string]$v) -replace "[`t`r`n]", " ")
            }
            $lines.Add($row -join "`t")
        }
    } finally { $rd.Close() }
    $pp = Join-Path $Out $fileName
    [IO.File]::WriteAllLines($pp, $lines, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host ("  {0}: {1} rows" -f $fileName, ($lines.Count - 1))
}

try {
    $cs = "Server=(localdb)\$Instance;Integrated Security=true;Connection Timeout=120"
    try { $conn = New-Object System.Data.SqlClient.SqlConnection $cs; $conn.Open() }
    catch {
        $cs = "Server=(localdb)\MSSQLLocalDB;Integrated Security=true;Connection Timeout=120"
        $conn = New-Object System.Data.SqlClient.SqlConnection $cs; $conn.Open()
    }
    $cmd = $conn.CreateCommand(); $cmd.CommandTimeout = $TimeoutSec
    $cmd.CommandText = "CREATE DATABASE [$dbName] ON (FILENAME=N'$mdf') FOR ATTACH_REBUILD_LOG"
    [void]$cmd.ExecuteNonQuery()
    $conn.ChangeDatabase($dbName)
    $connected = $true

    Write-Tsv "10-screen.tsv" @"
SELECT b.ObjName AS screen,
       p.ObjName AS folder,
       s.Number   AS screen_number,
       s.ScreenDeviceType AS device_type,
       (SELECT COUNT(1) FROM HmiBasicTable i
         WHERE i.ParentId = b.ObjId AND i.Deleted = 0) AS item_count
FROM HmiBasicTable b
LEFT JOIN HmiBasicTable p ON p.ObjId = b.ParentId
LEFT JOIN HmiScreenTable s ON s.Id = b.ObjId
WHERE b.ObjTypeCode = 1687591545 AND b.Deleted = 0
ORDER BY ISNULL(s.Number, 9999), b.ObjName
"@

    Write-Tsv "11-item.tsv" @"
SELECT s.ObjName AS screen,
       it.ObjName AS item,
       si.HmiSubType AS subtype,
       si.LocationX AS x, si.LocationY AS y,
       si.SizeX AS width, si.SizeY AS height
FROM HmiBasicTable it
JOIN HmiBasicTable s ON s.ObjId = it.ParentId
LEFT JOIN HmiScreenItemTable si ON si.Id = it.ObjId
WHERE s.ObjTypeCode = 1687591545 AND it.Deleted = 0
ORDER BY s.ObjName, si.LocationY, si.LocationX
"@

    Write-Tsv "12-text.tsv" @"
SELECT s.ObjName AS screen,
       p.ObjName AS folder,
       it.ObjName AS item,
       x.Language0 AS zh,
       x.Language1 AS en,
       x.IsHiddenText AS hidden,
       x.IsSystemMessageText AS system_message,
       x.TextType AS text_type,
       si.LocationX AS x, si.LocationY AS y
FROM HmiBasicTable t
JOIN HmiTextTable x ON x.Id = t.ObjId
JOIN HmiBasicTable it ON it.ObjId = t.ParentId
JOIN HmiBasicTable s  ON s.ObjId  = it.ParentId
LEFT JOIN HmiBasicTable p ON p.ObjId = s.ParentId
LEFT JOIN HmiScreenItemTable si ON si.Id = it.ObjId
WHERE s.ObjTypeCode = 1687591545 AND t.Deleted = 0
  AND (x.Language0 IS NOT NULL AND LTRIM(RTRIM(x.Language0)) <> '')
ORDER BY s.ObjName, si.LocationY, si.LocationX
"@

    Write-Tsv "13-tag.tsv" @"
SELECT b.ObjName AS tag, b.DeviceNumber AS device_number
FROM HmiBasicTable b
WHERE b.ObjTypeCode = 1179361025 AND b.Deleted = 0
ORDER BY b.ObjName
"@

    Write-Tsv "14-type.tsv" @"
SELECT ObjTypeCode AS type_code, COUNT(1) AS row_count
FROM HmiBasicTable
WHERE Deleted = 0
GROUP BY ObjTypeCode
ORDER BY COUNT(1) DESC
"@

} catch {
    Write-Error ("attach/query failed: " + $_.Exception.Message)
    throw
} finally {
    if ($connected -and $cs) {
        try {
            $c2 = New-Object System.Data.SqlClient.SqlConnection $cs; $c2.Open()
            $cc = $c2.CreateCommand(); $cc.CommandTimeout = 300
            $cc.CommandText = "IF DB_ID(N'$dbName') IS NOT NULL BEGIN ALTER DATABASE [$dbName] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [$dbName]; END"
            [void]$cc.ExecuteNonQuery(); $c2.Close()
        } catch { Write-Warning ("drop database failed: " + $_.Exception.Message) }
    }
    if ($conn -and $conn.State -ne "Closed") { $conn.Close() }
    try { Remove-Item -LiteralPath $tmp -Recurse -Force } catch {}
}

Write-Host ("DONE pages8192={0}" -f $pageOK)
