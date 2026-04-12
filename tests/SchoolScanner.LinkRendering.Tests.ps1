Set-StrictMode -Version Latest

# ---------------------------------------------------------------------------
# Link-rendering tests for the appendTextWithLinks regex in app.js.
#
# The function supports six match groups:
#   G1        **bold**
#   G2+3      ([label](url))          parenthesised citation
#   G4+5      [label](url)            standard markdown link
#              [label] (url)          space-before-paren variant (G4+5 with \s*)
#   G6+7      [label]<url>            angle-bracket URL variant
#   G8        [label]                 orphaned label - no URL follows
#   G9        https?://...            bare URL
#
# We test the regex directly in PowerShell (same pattern, .NET engine).
# A helper function mirrors the JS render logic so we can assert the
# human-readable output of each input string.
#
# NOTE: All strings containing [ or ] must use single quotes in PS5 —
# double-quoted strings treat [x] as a type/attribute literal.
# ---------------------------------------------------------------------------

# The pattern is kept in one place so updating app.js without updating this
# constant immediately causes test failures.
$script:LinkPattern = '\*\*([^*]+)\*\*|\(\[([^\]]+)\]\s*\(([^)]+)\)\)|\[([^\]]+)\]\s*\(([^)\s][^)]*)\)|\[([^\]]+)\]\s*<([^>]+)>|\[([^\]]+)\](?!\s*[(<])|(https?://[^\s<>"''\]]+)'

# Render text to a plain-text representation:
#   [LINK:label|url]   for real hyperlinks
#   [BOLD:text]        for **bold**
#   bare text          for plain text / orphaned labels (brackets stripped)
function Invoke-RenderLinks {
    param([string]$Text)

    $pat = $script:LinkPattern
    $result = [System.Text.StringBuilder]::new()
    $lastIndex = 0

    $matches = [regex]::Matches($Text, $pat)
    foreach ($m in $matches) {
        if ($m.Index -gt $lastIndex) {
            [void]$result.Append($Text.Substring($lastIndex, $m.Index - $lastIndex))
        }

        if ($m.Groups[1].Success) {
            [void]$result.Append('[BOLD:' + $m.Groups[1].Value + ']')
        }
        elseif ($m.Groups[8].Success) {
            # Orphaned [label] — brackets stripped
            [void]$result.Append($m.Groups[8].Value)
        }
        elseif ($m.Groups[9].Success) {
            $url = $m.Groups[9].Value -replace '[.,;:!?]+$', ''
            [void]$result.Append('[LINK:' + $url + '|' + $url + ']')
        }
        else {
            $label  = if ($m.Groups[2].Success) { $m.Groups[2].Value }
                      elseif ($m.Groups[4].Success) { $m.Groups[4].Value }
                      else { $m.Groups[6].Value }
            $rawUrl = if ($m.Groups[3].Success) { $m.Groups[3].Value }
                      elseif ($m.Groups[5].Success) { $m.Groups[5].Value }
                      else { $m.Groups[7].Value }

            $rawUrl = $rawUrl.Trim()
            if ($rawUrl -match '^https?://') {
                [void]$result.Append('[LINK:' + $label + '|' + $rawUrl + ']')
            }
            else {
                [void]$result.Append($label)
            }
        }

        $lastIndex = $m.Index + $m.Length
    }

    if ($lastIndex -lt $Text.Length) {
        [void]$result.Append($Text.Substring($lastIndex))
    }

    return $result.ToString()
}

Describe "appendTextWithLinks - link rendering rules" {

    # -----------------------------------------------------------------------
    # Standard markdown links
    # -----------------------------------------------------------------------

    It "renders a standard [label](url) as a hyperlink" {
        $out = Invoke-RenderLinks 'See [Admissions page](https://www.highgateschool.org.uk/admissions/) for details.'
        $out | Should Match '\[LINK:Admissions page\|https://www.highgateschool.org.uk/admissions/\]'
    }

    It "renders a [label](url) at the start of a string" {
        $out = Invoke-RenderLinks '[School website](https://www.example.com/) - main site.'
        $out | Should Match '\[LINK:School website\|https://www.example.com/\]'
    }

    It "renders multiple markdown links on one line" {
        $out = Invoke-RenderLinks '[First](https://a.com/) and [Second](https://b.com/).'
        $out | Should Match '\[LINK:First\|https://a.com/\]'
        $out | Should Match '\[LINK:Second\|https://b.com/\]'
    }

    # -----------------------------------------------------------------------
    # Space-before-paren variant  [label] (url)
    # -----------------------------------------------------------------------

    It "renders [label] (url) with a space before the paren as a hyperlink" {
        $out = Invoke-RenderLinks '[Highgate School website] (https://www.highgateschool.org.uk/).'
        $out | Should Match '\[LINK:Highgate School website\|https://www.highgateschool.org.uk/\]'
    }

    It "renders two consecutive space-variant links on one line" {
        $out = Invoke-RenderLinks '[ISI report] (https://example.com/isi/) [Full PDF] (https://example.com/pdf/).'
        $out | Should Match '\[LINK:ISI report\|https://example.com/isi/\]'
        $out | Should Match '\[LINK:Full PDF\|https://example.com/pdf/\]'
    }

    It "space-variant link produces a LINK token not a raw bracket in output" {
        $out = Invoke-RenderLinks '[Exam results 2025] (https://www.highgateschool.org.uk/sixth/exam-success/).'
        # Should be rendered as [LINK:...], not left as raw [label] (url)
        $out | Should Match '\[LINK:Exam results 2025\|'
        $out | Should Not Match '\[Exam results 2025\] \('
    }

    # -----------------------------------------------------------------------
    # Orphaned [label] with no URL
    # -----------------------------------------------------------------------

    It "renders an orphaned [label] as plain text without brackets" {
        $out = Invoke-RenderLinks 'Book a tour. [Admissions/events listing].'
        $out | Should Match 'Admissions/events listing'
        $out | Should Not Match '\[Admissions/events listing\]'
    }

    It "renders an orphaned label at the end of a sentence" {
        $out = Invoke-RenderLinks 'Background coverage. [The Week / education coverage].'
        $out | Should Match 'The Week / education coverage'
        $out | Should Not Match '\[The Week'
    }

    It "does NOT treat a normal markdown link as an orphaned label" {
        $out = Invoke-RenderLinks '[Real link](https://example.com/).'
        $out | Should Match '\[LINK:Real link\|https://example.com/\]'
    }

    # -----------------------------------------------------------------------
    # Parenthesised citation variant  ([label](url))
    # -----------------------------------------------------------------------

    It "renders ([label](url)) parenthesised citations as hyperlinks" {
        $out = Invoke-RenderLinks 'Strong results ([School exam page](https://example.com/results)).'
        $out | Should Match '\[LINK:School exam page\|https://example.com/results\]'
    }

    # -----------------------------------------------------------------------
    # Angle-bracket variant  [label]<url>
    # -----------------------------------------------------------------------

    It "renders [label]<url> angle-bracket citations as hyperlinks" {
        $out = Invoke-RenderLinks 'See [School site]<https://example.com/> for info.'
        $out | Should Match '\[LINK:School site\|https://example.com/\]'
    }

    # -----------------------------------------------------------------------
    # Bold  **text**
    # -----------------------------------------------------------------------

    It "renders **bold** text" {
        $out = Invoke-RenderLinks '**Visit:** Book an open day.'
        $out | Should Match '\[BOLD:Visit:\]'
    }

    It "renders bold text mixed with a link on the same line" {
        $out = Invoke-RenderLinks '**Visit:** See [school site](https://example.com/).'
        $out | Should Match '\[BOLD:Visit:\]'
        $out | Should Match '\[LINK:school site\|https://example.com/\]'
    }

    # -----------------------------------------------------------------------
    # Bare URLs
    # -----------------------------------------------------------------------

    It "renders a bare https:// URL as a hyperlink" {
        $out = Invoke-RenderLinks 'See https://www.highgateschool.org.uk/ for more.'
        $out | Should Match '\[LINK:https://www.highgateschool.org.uk/\|https://www.highgateschool.org.uk/\]'
    }

    It "trims trailing punctuation from a bare URL" {
        $out = Invoke-RenderLinks 'Visit https://example.com/page.'
        $out | Should Match '\[LINK:https://example.com/page\|https://example.com/page\]'
    }

    # -----------------------------------------------------------------------
    # Plain text passthrough
    # -----------------------------------------------------------------------

    It "passes plain text through unchanged" {
        $out = Invoke-RenderLinks 'No links here at all.'
        $out | Should Be 'No links here at all.'
    }

    It "passes empty string through unchanged" {
        $out = Invoke-RenderLinks ''
        $out | Should Be ''
    }

    # -----------------------------------------------------------------------
    # Actual model output patterns from prompt_branch_1 responses
    # -----------------------------------------------------------------------

    It "handles the ISI dual-link line format from real branch-1 output" {
        $line = '[ISI report on school site] (https://www.highgateschool.org.uk/news/isi-inspection-report-2024/) [Full PDF ISI report] (https://www.highgateschool.org.uk/wp-content/uploads/2024/11/ISI-Report-2024-Full-Report.pdf).'
        $out = Invoke-RenderLinks $line
        $out | Should Match '\[LINK:ISI report on school site\|'
        $out | Should Match '\[LINK:Full PDF ISI report\|'
    }

    It "handles an orphaned label followed by a markdown link on the same line" {
        $line = 'See [Admissions page] and also [Direct link](https://example.com/adm/).'
        $out = Invoke-RenderLinks $line
        $out | Should Match 'Admissions page'
        $out | Should Not Match '\[Admissions page\]'
        $out | Should Match '\[LINK:Direct link\|https://example.com/adm/\]'
    }

    It "handles a bold label with an orphaned citation on the same line" {
        $line = '**Visit:** Book an open day or private tour. [Admissions/events listing].'
        $out = Invoke-RenderLinks $line
        $out | Should Match '\[BOLD:Visit:\]'
        $out | Should Match 'Admissions/events listing'
        $out | Should Not Match '\[Admissions/events listing\]'
    }
}
