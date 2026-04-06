param(
    [string[]]$InputPaths
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-PdfObjects {
    param(
        [byte[]]$Bytes
    )

    $text = [System.Text.Encoding]::ASCII.GetString($Bytes)
    $matches = [regex]::Matches($text, '(?s)(\d+)\s+0\s+obj\s*(.*?)\s*endobj')
    $objects = @{}

    foreach ($match in $matches) {
        $id = [int]$match.Groups[1].Value
        $body = $match.Groups[2].Value
        $objects[$id] = [pscustomobject]@{
            Id    = $id
            Body  = $body
            Index = $match.Index
        }
    }

    return @{
        Text    = $text
        Objects = $objects
    }
}

function Get-StreamBytes {
    param(
        [byte[]]$Bytes,
        [string]$Text,
        [int]$ObjectIndex
    )

    $streamIdx = $Text.IndexOf('stream', $ObjectIndex)
    if ($streamIdx -lt 0) { return $null }

    $endIdx = $Text.IndexOf('endstream', $streamIdx)
    if ($endIdx -lt 0) { return $null }

    $start = $streamIdx + 6
    if ($Bytes[$start] -eq 13 -and $Bytes[$start + 1] -eq 10) {
        $start += 2
    }
    elseif ($Bytes[$start] -eq 10) {
        $start += 1
    }

    $length = $endIdx - $start
    if ($length -le 0) { return $null }

    $data = New-Object byte[] $length
    [Array]::Copy($Bytes, $start, $data, 0, $length)
    return $data
}

function Expand-Flate {
    param(
        [byte[]]$Data
    )

    if (-not $Data -or $Data.Length -lt 7) { return $null }

    $payload = New-Object byte[] ($Data.Length - 6)
    [Array]::Copy($Data, 2, $payload, 0, $Data.Length - 6)

    $input = New-Object System.IO.MemoryStream(, $payload)
    $inflate = New-Object System.IO.Compression.DeflateStream($input, [System.IO.Compression.CompressionMode]::Decompress)
    $output = New-Object System.IO.MemoryStream
    try {
        $inflate.CopyTo($output)
        return $output.ToArray()
    }
    finally {
        $inflate.Dispose()
        $input.Dispose()
        $output.Dispose()
    }
}

function Get-ToUnicodeMap {
    param(
        [string]$MapText
    )

    $map = @{}

    foreach ($entry in [regex]::Matches($MapText, '(?ms)(\d+)\s+beginbfchar\s*(.*?)\s*endbfchar')) {
        $body = $entry.Groups[2].Value
        foreach ($pair in [regex]::Matches($body, '<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>')) {
            $src = [Convert]::ToInt32($pair.Groups[1].Value, 16)
            $dst = [Convert]::ToInt32($pair.Groups[2].Value, 16)
            $map[$src] = [char]$dst
        }
    }

    foreach ($entry in [regex]::Matches($MapText, '(?ms)(\d+)\s+beginbfrange\s*(.*?)\s*endbfrange')) {
        $body = $entry.Groups[2].Value
        foreach ($range in [regex]::Matches($body, '<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>')) {
            $srcStart = [Convert]::ToInt32($range.Groups[1].Value, 16)
            $srcEnd = [Convert]::ToInt32($range.Groups[2].Value, 16)
            $dstStart = [Convert]::ToInt32($range.Groups[3].Value, 16)
            for ($i = 0; $i -le ($srcEnd - $srcStart); $i++) {
                $map[$srcStart + $i] = [char]($dstStart + $i)
            }
        }
    }

    return $map
}

function Get-FontMaps {
    param(
        [byte[]]$Bytes,
        [string]$Text,
        [hashtable]$Objects
    )

    $fontMaps = @{}

    foreach ($object in $Objects.Values) {
        if ($object.Body -notmatch '/Type\s*/Font') { continue }
        if ($object.Body -notmatch '/ToUnicode\s+(\d+)\s+0\s+R') { continue }

        $toUnicodeId = [int]$Matches[1]
        if (-not $Objects.ContainsKey($toUnicodeId)) { continue }

        $mapObject = $Objects[$toUnicodeId]
        $streamBytes = Get-StreamBytes -Bytes $Bytes -Text $Text -ObjectIndex $mapObject.Index
        if (-not $streamBytes) { continue }

        try {
            $decoded = Expand-Flate -Data $streamBytes
            $mapText = [System.Text.Encoding]::ASCII.GetString($decoded)
            $fontMaps[$object.Id] = Get-ToUnicodeMap -MapText $mapText
        }
        catch {
            continue
        }
    }

    return $fontMaps
}

function Get-PageDefinitions {
    param(
        [hashtable]$Objects
    )

    $pages = [System.Collections.Generic.List[object]]::new()

    foreach ($object in ($Objects.Values | Sort-Object Id)) {
        if ($object.Body -notmatch '/Type\s*/Page(?!s)') { continue }

        $contentIds = [System.Collections.Generic.List[int]]::new()
        $contentMatch = [regex]::Match($object.Body, '/Contents\s+(\d+)\s+0\s+R')
        if ($contentMatch.Success) {
            $contentIds.Add([int]$contentMatch.Groups[1].Value)
        }
        else {
            $arrayMatch = [regex]::Match($object.Body, '(?s)/Contents\s*\[(.*?)\]')
            if ($arrayMatch.Success) {
                foreach ($item in [regex]::Matches($arrayMatch.Groups[1].Value, '(\d+)\s+0\s+R')) {
                    $contentIds.Add([int]$item.Groups[1].Value)
                }
            }
        }

        $resourceId = $null
        $resourceMatch = [regex]::Match($object.Body, '/Resources\s+(\d+)\s+0\s+R')
        if ($resourceMatch.Success) {
            $resourceId = [int]$resourceMatch.Groups[1].Value
        }

        $pages.Add([pscustomobject]@{
            PageId     = $object.Id
            ContentIds = $contentIds
            ResourceId = $resourceId
            Body       = $object.Body
        })
    }

    return $pages
}

function Get-PageFontRefs {
    param(
        [pscustomobject]$Page,
        [hashtable]$Objects
    )

    $refs = @{}
    $resourceBody = $null
    if ($Page.ResourceId -and $Objects.ContainsKey($Page.ResourceId)) {
        $resourceBody = $Objects[$Page.ResourceId].Body
    }
    else {
        $inlineResource = [regex]::Match($Page.Body, '(?s)/Resources\s*<<(.*?)>>')
        if ($inlineResource.Success) {
            $resourceBody = $inlineResource.Groups[1].Value
        }
    }

    if (-not $resourceBody) {
        return $refs
    }

    $fontBlock = [regex]::Match($resourceBody, '(?s)/Font\s*<<(.*?)>>')
    if (-not $fontBlock.Success) {
        return $refs
    }

    foreach ($fontMatch in [regex]::Matches($fontBlock.Groups[1].Value, '/([A-Za-z0-9]+)\s+(\d+)\s+0\s+R')) {
        $refs["/" + $fontMatch.Groups[1].Value] = [int]$fontMatch.Groups[2].Value
    }

    return $refs
}

function Decode-PdfLiteralString {
    param(
        [string]$Token,
        [hashtable]$FontMap
    )

    $bytes = [System.Collections.Generic.List[byte]]::new()

    for ($i = 0; $i -lt $Token.Length; $i++) {
        $ch = $Token[$i]
        if ($ch -eq '\') {
            if ($i + 1 -ge $Token.Length) { break }
            $i++
            $next = $Token[$i]
            switch ($next) {
                'n' { $bytes.Add(10); continue }
                'r' { $bytes.Add(13); continue }
                't' { $bytes.Add(9); continue }
                'b' { $bytes.Add(8); continue }
                'f' { $bytes.Add(12); continue }
                '(' { $bytes.Add([byte][char]'('); continue }
                ')' { $bytes.Add([byte][char]')'); continue }
                '\' { $bytes.Add([byte][char]'\'); continue }
                default {
                    if ($next -match '[0-7]') {
                        $octal = [string]$next
                        for ($j = 0; $j -lt 2 -and $i + 1 -lt $Token.Length -and $Token[$i + 1] -match '[0-7]'; $j++) {
                            $i++
                            $octal += $Token[$i]
                        }
                        $bytes.Add([Convert]::ToByte($octal, 8))
                    }
                    else {
                        $bytes.Add([byte][char]$next)
                    }
                }
            }
        }
        else {
            $bytes.Add([byte][char]$ch)
        }
    }

    if ($FontMap -and $FontMap.Count -gt 0) {
        $chars = New-Object System.Collections.Generic.List[char]
        for ($i = 0; $i -lt $bytes.Count; $i += 2) {
            if ($i + 1 -ge $bytes.Count) { break }
            $code = ($bytes[$i] -shl 8) -bor $bytes[$i + 1]
            if ($FontMap.ContainsKey($code)) {
                $chars.Add($FontMap[$code])
            }
        }
        return (-join $chars.ToArray())
    }

    return [System.Text.Encoding]::ASCII.GetString($bytes.ToArray())
}

function Decode-PdfHexString {
    param(
        [string]$Token,
        [hashtable]$FontMap
    )

    $clean = ($Token -replace '\s+', '')
    if (-not $clean) { return '' }

    $bytes = New-Object System.Collections.Generic.List[byte]
    for ($i = 0; $i -lt $clean.Length; $i += 2) {
        if ($i + 1 -ge $clean.Length) { break }
        $bytes.Add([Convert]::ToByte($clean.Substring($i, 2), 16))
    }

    if ($FontMap -and $FontMap.Count -gt 0) {
        $chars = New-Object System.Collections.Generic.List[char]
        for ($i = 0; $i -lt $bytes.Count; $i += 2) {
            if ($i + 1 -ge $bytes.Count) { break }
            $code = ($bytes[$i] -shl 8) -bor $bytes[$i + 1]
            if ($FontMap.ContainsKey($code)) {
                $chars.Add($FontMap[$code])
            }
        }
        return (-join $chars.ToArray())
    }

    return [System.Text.Encoding]::ASCII.GetString($bytes.ToArray())
}

function Decode-PdfArrayString {
    param(
        [string]$ArrayToken,
        [hashtable]$FontMap
    )

    $parts = [regex]::Matches($ArrayToken, '\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]+>')
    $decoded = foreach ($part in $parts) {
        if ($part.Value.StartsWith('(')) {
            Decode-PdfLiteralString -Token $part.Value.Substring(1, $part.Value.Length - 2) -FontMap $FontMap
        }
        else {
            Decode-PdfHexString -Token $part.Value.Substring(1, $part.Value.Length - 2) -FontMap $FontMap
        }
    }

    return (($decoded -join '') -replace '\s+', ' ').Trim()
}

function Get-TextElementsFromStream {
    param(
        [string]$StreamText,
        [hashtable]$PageFonts,
        [hashtable]$FontMaps,
        [int]$PageNumber
    )

    $elements = [System.Collections.Generic.List[object]]::new()

    foreach ($block in [regex]::Matches($StreamText, '(?s)BT(.*?)ET')) {
        $content = $block.Groups[1].Value
        $fontName = $null
        $fontId = $null
        $fontMap = $null
        $x = 0.0
        $y = 0.0

        $fontMatch = [regex]::Match($content, '/([A-Za-z0-9]+)\s+[\d\.\-]+\s+Tf')
        if ($fontMatch.Success) {
            $fontName = "/" + $fontMatch.Groups[1].Value
            if ($PageFonts.ContainsKey($fontName)) {
                $fontId = $PageFonts[$fontName]
                if ($FontMaps.ContainsKey($fontId)) {
                    $fontMap = $FontMaps[$fontId]
                }
            }
        }

        $tmMatch = [regex]::Match($content, '([\d\.\-]+)\s+([\d\.\-]+)\s+([\d\.\-]+)\s+([\d\.\-]+)\s+([\d\.\-]+)\s+([\d\.\-]+)\s+Tm')
        if ($tmMatch.Success) {
            $x = [double]$tmMatch.Groups[5].Value
            $y = [double]$tmMatch.Groups[6].Value
        }

        foreach ($tdMatch in [regex]::Matches($content, '([\d\.\-]+)\s+([\d\.\-]+)\s+Td')) {
            $x += [double]$tdMatch.Groups[1].Value
            $y += [double]$tdMatch.Groups[2].Value
        }

        foreach ($textMatch in [regex]::Matches($content, '(?s)(\((.*?)\)|<([0-9A-Fa-f\s]+)>)\s*Tj')) {
            if ($textMatch.Groups[2].Success) {
                $value = Decode-PdfLiteralString -Token $textMatch.Groups[2].Value -FontMap $fontMap
            }
            else {
                $value = Decode-PdfHexString -Token $textMatch.Groups[3].Value -FontMap $fontMap
            }
            if ($value.Trim()) {
                $elements.Add([pscustomobject]@{ Page = $PageNumber; X = $x; Y = $y; Text = $value.Trim() })
            }
        }

        foreach ($arrayMatch in [regex]::Matches($content, '(?s)\[(.*?)\]\s*TJ')) {
            $value = Decode-PdfArrayString -ArrayToken $arrayMatch.Groups[1].Value -FontMap $fontMap
            if ($value.Trim()) {
                $elements.Add([pscustomobject]@{ Page = $PageNumber; X = $x; Y = $y; Text = $value.Trim() })
            }
        }
    }

    return $elements
}

function Get-FixedColumns {
    param(
        [string]$PdfPath
    )

    if ($PdfPath -like '*\sources\Cambridge\*') {
        return @(
            [pscustomobject]@{ Name = 'UCAS Apply Centre'; X = 25.548 }
            [pscustomobject]@{ Name = 'Apply Centre Name'; X = 89.637 }
            [pscustomobject]@{ Name = 'Postcode'; X = 560.44 }
            [pscustomobject]@{ Name = 'School Sector'; X = 619.86 }
            [pscustomobject]@{ Name = 'Applications'; X = 753.27 }
            [pscustomobject]@{ Name = 'Offers'; X = 825.46 }
            [pscustomobject]@{ Name = 'Acceptances'; X = 897.68 }
        )
    }

    return @()
}

function Group-TextRows {
    param(
        [object[]]$Elements
    )

    $rows = [System.Collections.Generic.List[object]]::new()
    $current = $null

    foreach ($element in ($Elements | Sort-Object Page, @{ Expression = { [math]::Round($_.Y, 1) }; Descending = $true }, X)) {
        if (-not $current -or $current.Page -ne $element.Page -or [math]::Abs($current.Y - $element.Y) -gt 2.5) {
            if ($current) { $rows.Add($current) }
            $current = [pscustomobject]@{
                Page  = $element.Page
                Y     = $element.Y
                Cells = [System.Collections.Generic.List[object]]::new()
            }
        }

        $current.Cells.Add($element)
    }

    if ($current) { $rows.Add($current) }
    return $rows
}

function Get-HeaderColumns {
    param(
        [object[]]$Rows
    )

    $best = $null
    foreach ($row in $Rows) {
        $texts = $row.Cells | ForEach-Object { $_.Text }
        if (($texts -contains 'Applications') -or ($texts -contains 'Offers') -or ($texts -contains 'Acceptances') -or ($texts -contains 'Applicants')) {
            if (-not $best -or $row.Cells.Count -gt $best.Cells.Count) {
                $best = $row
            }
        }
    }

    if (-not $best) {
        $best = ($Rows | Sort-Object { $_.Cells.Count } -Descending | Select-Object -First 1)
    }

    if (-not $best) {
        return @()
    }

    return ($best.Cells | Sort-Object X | ForEach-Object {
        [pscustomobject]@{
            Name = $_.Text
            X    = $_.X
        }
    })
}

function Convert-RowsToRecords {
    param(
        [object[]]$Rows,
        [object[]]$Columns
    )

    $records = [System.Collections.Generic.List[object]]::new()
    $columnList = @($Columns)
    if (-not $columnList -or $columnList.Count -eq 0) {
        return $records
    }

    $headerNames = $columnList | ForEach-Object { $_.Name }

    foreach ($row in $Rows) {
        $cells = @($row.Cells | Sort-Object X)
        $texts = $cells | ForEach-Object { $_.Text }
        if (($texts -join ' ') -eq ($headerNames -join ' ')) { continue }
        if ($cells.Count -lt 2) { continue }

        $record = [ordered]@{}
        foreach ($name in $headerNames) {
            $record[$name] = ''
        }
        $record['Page'] = $row.Page

        foreach ($cell in $cells) {
            $closest = $columnList | Sort-Object { [math]::Abs($_.X - $cell.X) } | Select-Object -First 1
            if (-not $closest) { continue }

            if ($record[$closest.Name]) {
                $record[$closest.Name] = ($record[$closest.Name] + ' ' + $cell.Text).Trim()
            }
            else {
                $record[$closest.Name] = $cell.Text
            }
        }

        $nonBlank = @($record.GetEnumerator() | Where-Object { $_.Key -ne 'Page' -and $_.Value }).Count
        if ($nonBlank -ge 2) {
            $records.Add([pscustomobject]$record)
        }
    }

    return $records
}

function Convert-PdfToCsv {
    param(
        [string]$PdfPath
    )

    $bytes = [System.IO.File]::ReadAllBytes($PdfPath)
    $pdf = Get-PdfObjects -Bytes $bytes
    $objects = $pdf.Objects
    $fontMaps = Get-FontMaps -Bytes $bytes -Text $pdf.Text -Objects $objects
    $pages = Get-PageDefinitions -Objects $objects

    $elements = [System.Collections.Generic.List[object]]::new()
    $pageNumber = 0

    foreach ($page in $pages) {
        $pageNumber++
        $pageFonts = Get-PageFontRefs -Page $page -Objects $objects

        foreach ($contentId in $page.ContentIds) {
            if (-not $objects.ContainsKey($contentId)) { continue }
            $streamBytes = Get-StreamBytes -Bytes $bytes -Text $pdf.Text -ObjectIndex $objects[$contentId].Index
            if (-not $streamBytes) { continue }

            try {
                $decoded = Expand-Flate -Data $streamBytes
            }
            catch {
                continue
            }

            $streamText = [System.Text.Encoding]::ASCII.GetString($decoded)
            $streamElements = Get-TextElementsFromStream -StreamText $streamText -PageFonts $pageFonts -FontMaps $fontMaps -PageNumber $pageNumber
            foreach ($item in $streamElements) {
                $elements.Add($item)
            }
        }
    }

    $rows = Group-TextRows -Elements $elements.ToArray()
    $columns = Get-FixedColumns -PdfPath $PdfPath
    if (@($columns).Count -eq 0) {
        $columns = Get-HeaderColumns -Rows $rows
    }
    $records = Convert-RowsToRecords -Rows $rows -Columns $columns

    $csvPath = [System.IO.Path]::ChangeExtension($PdfPath, '.csv')
    if (@($records).Count -gt 0) {
        $records | Export-Csv -NoTypeInformation -Encoding UTF8 -Path $csvPath
    }
    else {
        $elements.ToArray() | Sort-Object Page, @{ Expression = { [math]::Round($_.Y, 1) }; Descending = $true }, X |
            Export-Csv -NoTypeInformation -Encoding UTF8 -Path $csvPath
    }
    return $csvPath
}

$files = [System.Collections.Generic.List[object]]::new()
if ($InputPaths -and $InputPaths.Count -gt 0) {
    foreach ($path in $InputPaths) {
        if (Test-Path $path -PathType Leaf) {
            $files.Add((Get-Item $path))
        }
        elseif (Test-Path $path -PathType Container) {
            foreach ($item in (Get-ChildItem -Path $path -Filter *.pdf -File)) {
                $files.Add($item)
            }
        }
    }
}
else {
    $targets = @(
        'C:\Users\Skye\Documents\Codex\Schools\sources\Oxford',
        'C:\Users\Skye\Documents\Codex\Schools\sources\Cambridge'
    )

    foreach ($folder in $targets) {
        foreach ($item in (Get-ChildItem -Path $folder -Filter *.pdf -File)) {
            $files.Add($item)
        }
    }
}

foreach ($file in $files) {
    try {
        $csvPath = Convert-PdfToCsv -PdfPath $file.FullName
        Write-Output "Created $csvPath"
    }
    catch {
        Write-Output "Failed $($file.FullName) at line $($_.InvocationInfo.ScriptLineNumber): $($_.Exception.Message)"
    }
}
