(function () {
  "use strict";

  const ENABLE_PAYWALL = false;
  const ENABLE_SECTION_FEEDBACK = true; // per-section thumbs up/down

  const form = document.getElementById("question-form");
  const branchInput = document.getElementById("branch-input");
  const branchGrid = document.getElementById("branch-grid");
  const questionField = document.getElementById("question");
  const submitButton = document.getElementById("submit-button");
  const formStatus = document.getElementById("form-status");
  const resultCard = document.getElementById("result-card");
  const resultTitle = document.getElementById("result-title");
  const resultSummary = document.getElementById("result-summary");
  const scorecardEl = document.getElementById("scorecard");
  const sectionsToolbar = document.getElementById("sections-toolbar");
  const toggleAllBtn = document.getElementById("toggle-all-btn");
  const answerSections = document.getElementById("answer-sections");
  const premiumPoints = document.getElementById("premium-points");
  const gateNote = document.getElementById("gate-note");
  const premiumPanel = document.getElementById("premium-panel");

  // ── Section collapse/expand ───────────────────────────────────────────

  var allExpanded = true;

  function updateToggleButton() {
    toggleAllBtn.textContent = allExpanded ? "Collapse all" : "Expand all";
  }

  function setAllSections(collapsed) {
    var articles = answerSections.querySelectorAll(".answer-section");
    articles.forEach(function (a) {
      if (collapsed) a.classList.add("collapsed");
      else a.classList.remove("collapsed");
    });
  }

  toggleAllBtn.addEventListener("click", function () {
    allExpanded = !allExpanded;
    setAllSections(!allExpanded);
    updateToggleButton();
  });

  // Delegated click on section headings to toggle individual sections
  answerSections.addEventListener("click", function (e) {
    var row = e.target.closest(".answer-section-heading-row");
    if (!row) return;
    var article = row.closest(".answer-section");
    if (!article) return;
    article.classList.toggle("collapsed");

    // Sync the "all" button: if any section is collapsed, we're not in "all expanded"
    var anyCollapsed = answerSections.querySelector(".answer-section.collapsed");
    allExpanded = !anyCollapsed;
    updateToggleButton();
  });

  function setStatus(message) {
    formStatus.textContent = message;
  }

  // Fire-and-forget analytics event. Silently swallows all errors.
  // Sends to the local server (relative path) in dev, or to the Lambda
  // Function URL in production, since CloudFront only routes /api/research.
  function trackEvent(name, props) {
    try {
      var payload = Object.assign({ event: name }, props || {});
      var body = JSON.stringify(payload);
      var blob = new Blob([body], { type: "application/json" });

      // On localhost, the PowerShell server handles /api/analytics/click.
      // On CloudFront, only /api/research is routed to Lambda — analytics
      // paths 404 from S3. Fall back to the raw Lambda URL so feedback
      // events actually land in CloudWatch.
      var isLocal = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
      var analyticsUrl = isLocal
        ? "/api/analytics/click"
        : "https://ep6az35owvnis2c6n6wcl7axyy0elrlh.lambda-url.eu-west-2.on.aws/api/analytics/click";

      // Always use fetch for cross-origin analytics. sendBeacon with
      // Blob+JSON triggers a CORS preflight that sends credentials,
      // and the Lambda doesn't return Access-Control-Allow-Credentials.
      // Localhost: use sendBeacon (same-origin, no CORS preflight).
      if (isLocal) {
        try {
          if (navigator.sendBeacon) { navigator.sendBeacon(analyticsUrl, blob); }
          else {
            fetch(analyticsUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: body, keepalive: true }).catch(function () {});
          }
        } catch (_e) {}
      } else {
        fetch(analyticsUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body,
          keepalive: true,
          credentials: "omit"
        }).catch(function () {});
      }
    } catch (_e) {}
  }

  function selectBranch(branch) {
    branchInput.value = branch;
    const cards = branchGrid.querySelectorAll("[data-branch]");
    cards.forEach(function (card) {
      const selected = card.getAttribute("data-branch") === branch;
      card.classList.toggle("is-selected", selected);
      card.setAttribute("aria-pressed", selected ? "true" : "false");
    });
    trackEvent("branch_selected", { branch: branch });
  }

  function renderList(target, items) {
    target.replaceChildren();
    (items || []).forEach(function (item) {
      const li = document.createElement("li");
      li.textContent = item;
      target.appendChild(li);
    });
  }

  var RATING_LABELS = { strong: "Strong", good: "Good", mixed: "Mixed", weak: "Weak", unknown: "?" };

  function renderScorecard(items) {
    scorecardEl.replaceChildren();
    if (!items || items.length === 0) {
      scorecardEl.hidden = true;
      return;
    }
    items.forEach(function (item) {
      var row = document.createElement("div");
      row.className = "scorecard-row";

      var dim = document.createElement("span");
      dim.className = "scorecard-dimension";
      dim.textContent = item.dimension || "";

      var badge = document.createElement("span");
      var rating = (item.rating || "unknown").toLowerCase();
      badge.className = "scorecard-badge rating-" + rating;
      badge.textContent = RATING_LABELS[rating] || rating;

      var note = document.createElement("span");
      note.className = "scorecard-note";
      appendTextWithLinks(note, item.note || "");

      row.appendChild(dim);
      row.appendChild(badge);
      row.appendChild(note);
      scorecardEl.appendChild(row);
    });
    scorecardEl.hidden = false;
  }

  // Appends text to an element, turning markdown citations into real <a> elements
  // and **bold** spans into <strong> elements.
  // Handles:
  //   **bold**         – bold text
  //   ([label](url))   – wrapped in outer parens
  //   [label](url)     – plain markdown link
  //   [label]<url>     – angle-bracket URL variant
  // All other text is inserted as safe text nodes.
  function appendTextWithLinks(el, text) {
    // G1:   **bold**
    // G2+3: ([label](url))  — parenthesised citation variant
    // G4+5: [label](url) or [label] (url) — standard markdown link; \s* tolerates a space
    // G6+7: [label]<url>   — angle-bracket URL variant
    // G8:   [label]        — orphaned label with no URL; rendered as plain text (brackets stripped)
    // G9:   bare https?:// URL
    var pattern = /\*\*([^*]+)\*\*|\(\[([^\]]+)\]\s*\(([^)]+)\)\)|\[([^\]]+)\]\s*\(([^)\s][^)]*)\)|\[([^\]]+)\]\s*<([^>]+)>|\[([^\]]+)\](?!\s*[(<])|(https?:\/\/[^\s<>"'\]]+)/g;
    var lastIndex = 0;
    var match;

    while ((match = pattern.exec(text)) !== null) {
      if (match.index > lastIndex) {
        el.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }

      if (match[1] !== undefined) {
        // **bold**
        var strong = document.createElement("strong");
        strong.textContent = match[1];
        el.appendChild(strong);
      } else if (match[8] !== undefined) {
        // Orphaned [label] — drop the brackets, show label as plain text
        el.appendChild(document.createTextNode(match[8]));
      } else if (match[9] !== undefined) {
        // Bare URL — make it a link using the URL as both href and label
        var bareUrl = match[9].replace(/[.,;:!?]+$/, ""); // trim trailing punctuation
        var a = document.createElement("a");
        a.href = bareUrl;
        a.textContent = bareUrl;
        a.rel = "noopener noreferrer";
        a.target = "_blank";
        el.appendChild(a);
      } else {
        var label = match[2] || match[4] || match[6];
        var rawUrl = match[3] || match[5] || match[7];

        if (/^https?:\/\//i.test(rawUrl)) {
          var cleanUrl = rawUrl.trim();
          try {
            var u = new URL(cleanUrl);
            u.searchParams.delete("utm_source");
            cleanUrl = u.toString();
          } catch (_e) {}

          var a = document.createElement("a");
          a.href = cleanUrl;
          a.textContent = label;
          a.rel = "noopener noreferrer";
          a.target = "_blank";
          el.appendChild(a);
        } else {
          el.appendChild(document.createTextNode(label));
        }
      }

      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      el.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  function isTableSeparator(line) {
    return /^\|[\s|:-]+\|$/.test(line);
  }

  function parseTableRow(line) {
    return line.replace(/^\||\|$/g, "").split("|").map(function (c) { return c.trim(); });
  }

  function renderTable(container, tableLines) {
    var table = document.createElement("table");
    var tbody = null;
    var colCount = 0;
    var isEvidenceTable = false; // only C1 has "Evidence level" column

    tableLines.forEach(function (line, i) {
      if (isTableSeparator(line)) return;
      var cells = parseTableRow(line);
      if (i === 0) {
        colCount = cells.length;
        // Detect C1 table by "Evidence level" header
        isEvidenceTable = cells.some(function (c) { return /evidence\s*level/i.test(c); });
        var thead = document.createElement("thead");
        var tr = document.createElement("tr");
        cells.forEach(function (cell) {
          var th = document.createElement("th");
          appendTextWithLinks(th, cell);
          tr.appendChild(th);
        });
        thead.appendChild(tr);
        table.appendChild(thead);
        tbody = document.createElement("tbody");
        table.appendChild(tbody);
      } else {
        var tr = document.createElement("tr");
        cells.forEach(function (cell, ci) {
          var td = document.createElement("td");
          if (isEvidenceTable) {
            var trimmed = cell.trim();
            var evidenceClass = null;
            if (/^Strong$/i.test(trimmed)) evidenceClass = 'evidence-strong';
            else if (/^Present$/i.test(trimmed)) evidenceClass = 'evidence-good';
            else if (/^Mixed$/i.test(trimmed)) evidenceClass = 'evidence-mixed';
            else if (/^Weak$/i.test(trimmed)) evidenceClass = 'evidence-weak';
            else if (/^Not evident$/i.test(trimmed)) evidenceClass = 'evidence-unknown';
            if (evidenceClass) {
              var span = document.createElement("span");
              span.className = evidenceClass;
              span.textContent = trimmed;
              td.appendChild(span);
              tr.appendChild(td);
              return;
            }
          }
          appendTextWithLinks(td, cell);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
    });
    table.className = "md-table cols-" + colCount;
    var scroll = document.createElement("div");
    scroll.className = "table-scroll";
    scroll.appendChild(table);
    container.appendChild(scroll);
  }

  function renderBodyText(container, rawText) {
    container.replaceChildren();
    var tableLines = [];
    var inTable = false;

    function flushTable() {
      if (tableLines.length > 0) {
        renderTable(container, tableLines);
        tableLines = [];
      }
      inTable = false;
    }

    var rawLines = (rawText || "").split("\n");

    var currentList = null;
    var currentListType = null;
    var lastOlLi = null;   // last <li> of an <ol> — bullets after it nest inside
    var nestedUl = null;   // nested <ul> inside an <ol> <li>
    var groupList = null;  // <ul> collecting sub-bullets under a bold-header bullet

    rawLines.forEach(function (rawLine) {
      var line = rawLine.trim();

      if (!line.length) {
        if (inTable) flushTable();
        // Blank lines don't break an active list context (e.g. school entries
        // in a numbered list separated by blank lines). Only reset nested state.
        nestedUl = null;
        return;
      }

      // Table row detection. Accepts both strict markdown (|...|) and
      // loose AI output where pipes appear inline without outer framing.
      // Requires ≥2 pipes to avoid matching single-pipe prose.
      if (/^\|.+\|$/.test(line) || (line.split('|').length >= 3 && !/^[-*]/.test(line))) {
        // Normalise: add leading/trailing pipes if the AI omitted them
        var normalised = line;
        if (!normalised.startsWith('|')) normalised = '| ' + normalised;
        if (!normalised.endsWith('|')) normalised = normalised + ' |';
        inTable = true;
        currentList = null; currentListType = null;
        lastOlLi = null; nestedUl = null; groupList = null;
        tableLines.push(normalised);
        return;
      }
      if (inTable) flushTable();

      var bulletMatch   = line.match(/^[-*]\s+(.+)/);
      var numberedMatch = line.match(/^\d+[).]\s+(.+)/);

      // Bold-only bullet: - **Option name** (nothing else after the closing **)
      // Rendered as a group header <p><strong>…</strong></p> with subsequent
      // bullets collected into a nested <ul class="group-list">.
      var boldOnlyBullet = bulletMatch && /^\*\*[^*]+\*\*\s*$/.test(bulletMatch[1]);

      if (numberedMatch) {
        // Top-level numbered item — resets group and nested state
        nestedUl = null;
        groupList = null;
        if (currentListType !== "ol") {
          currentList = document.createElement("ol");
          container.appendChild(currentList);
          currentListType = "ol";
        }
        var li = document.createElement("li");
        appendTextWithLinks(li, numberedMatch[1]);
        currentList.appendChild(li);
        lastOlLi = li;

      } else if (boldOnlyBullet) {
        // Bold-only bullet → group header paragraph + new groupList
        currentList = null; currentListType = null;
        lastOlLi = null; nestedUl = null;
        var boldText = bulletMatch[1].replace(/^\*\*|\*\*\s*$/g, "");
        var groupP = document.createElement("p");
        groupP.className = "group-header";
        var strong = document.createElement("strong");
        strong.textContent = boldText;
        groupP.appendChild(strong);
        container.appendChild(groupP);
        groupList = document.createElement("ul");
        groupList.className = "group-list";
        container.appendChild(groupList);

      } else if (bulletMatch && groupList) {
        // Regular bullet following a bold group header → sub-item of that group
        var li = document.createElement("li");
        appendTextWithLinks(li, bulletMatch[1]);
        groupList.appendChild(li);

      } else if (bulletMatch && lastOlLi) {
        // Bullet inside a numbered-list context → always nest (model often
        // drops leading spaces when serialising to JSON)
        groupList = null;
        if (!nestedUl) {
          nestedUl = document.createElement("ul");
          nestedUl.className = "nested-list";
          lastOlLi.appendChild(nestedUl);
        }
        var li = document.createElement("li");
        appendTextWithLinks(li, bulletMatch[1]);
        nestedUl.appendChild(li);

      } else if (bulletMatch) {
        // Top-level bullet — no numbered or group context active
        nestedUl = null; lastOlLi = null; groupList = null;
        if (currentListType !== "ul") {
          currentList = document.createElement("ul");
          container.appendChild(currentList);
          currentListType = "ul";
        }
        var li = document.createElement("li");
        appendTextWithLinks(li, bulletMatch[1]);
        currentList.appendChild(li);

      } else {
        // Plain paragraph — resets all list/group context
        currentList = null; currentListType = null;
        lastOlLi = null; nestedUl = null; groupList = null;
        var p = document.createElement("p");
        appendTextWithLinks(p, line);
        container.appendChild(p);
      }
    });

    if (inTable) flushTable();
  }

  function renderSections(sections) {
    answerSections.replaceChildren();
    (sections || []).forEach(function (section) {
      const flag = section.flag || "none";

      // Part label (A/B/C) — render glued immediately above this section
      if (section._partLabel) {
        const div = document.createElement("div");
        div.className = "part-divider";
        div.textContent = section._partLabel;
        answerSections.appendChild(div);
      }

      const article = document.createElement("article");
      article.className = "answer-section" + (flag !== "none" ? " answer-section--" + flag : "") + (section._partLabel ? " answer-section--has-part-label" : "");

      const headingRow = document.createElement("div");
      headingRow.className = "answer-section-heading-row";

      const heading = document.createElement("h4");
      heading.textContent = section.heading || "";

      headingRow.appendChild(heading);

      // Per-section feedback mini-widget (beta)
      if (ENABLE_SECTION_FEEDBACK) {
        const secHeading = section.heading || "";

        const mini = document.createElement("span");
        mini.className = "section-feedback-mini";
        mini.setAttribute("data-section", secHeading);

        const label = document.createElement("span");
        label.className = "sfm-label";
        label.textContent = "Was it useful?";

        const upBtn = document.createElement("button");
        upBtn.className = "sfm-btn sfm-up";
        upBtn.type = "button";
        upBtn.setAttribute("data-rating", "up");
        upBtn.title = "This section was useful";
        upBtn.textContent = "👍";
        upBtn.setAttribute("aria-label", "Thumbs up");

        const downBtn = document.createElement("button");
        downBtn.className = "sfm-btn sfm-down";
        downBtn.type = "button";
        downBtn.setAttribute("data-rating", "down");
        downBtn.title = "This section needs work";
        downBtn.textContent = "👎";
        downBtn.setAttribute("aria-label", "Thumbs down");

        const thanks = document.createElement("span");
        thanks.className = "sfm-thanks";
        thanks.textContent = "✓";
        thanks.hidden = true;

        mini.appendChild(label);
        mini.appendChild(upBtn);
        mini.appendChild(downBtn);
        mini.appendChild(thanks);
        headingRow.appendChild(mini);
      }

      const body = document.createElement("div");
      body.className = "answer-section-body";
      renderBodyText(body, section.body || "");

      article.appendChild(headingRow);
      article.appendChild(body);
      answerSections.appendChild(article);
    });
  }

  function renderResult(result, modeLabel) {
    // API-level errors: display the message instead of a blank page
    if (result.error) {
      resultTitle.textContent = "Not possible to complete the request";
      resultSummary.replaceChildren();
      resultSummary.textContent = result.error;
      scorecardEl.hidden = true;
      sectionsToolbar.hidden = true;
      answerSections.replaceChildren();
      resultCard.hidden = false;
      setStatus(modeLabel);
      return;
    }

    resultTitle.textContent = result.title || "Answer";
    resultSummary.replaceChildren();
    appendTextWithLinks(resultSummary, result.summary || "");
    renderScorecard(result.scorecard || []);
    renderSections(result.sections || []);
    resetFeedbackForm();

    // Show section toggle toolbar when there are sections
    if (result.sections && result.sections.length > 0) {
      sectionsToolbar.hidden = false;
      allExpanded = true;
      updateToggleButton();
    } else {
      sectionsToolbar.hidden = true;
    }

    if (ENABLE_PAYWALL) {
      premiumPanel.hidden = false;
      renderList(premiumPoints, result.premiumPoints || []);
      gateNote.textContent = result.gate && result.gate.note ? result.gate.note : "";
    } else {
      premiumPanel.hidden = true;
      premiumPoints.replaceChildren();
      gateNote.textContent = "";
    }

    resultCard.hidden = false;
    setStatus(modeLabel);
    resultCard.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function getResponseStatusMessage(response, result) {
    if (response.ok) {
      return "Answer ready.";
    }

    if (response.status === 429) {
      return "Research provider is rate-limiting requests. Please retry shortly.";
    }

    if (response.status === 504) {
      return "Research timed out before completion. Try a narrower question or retry.";
    }

    if (result && result.status === "configuration_required") {
      return "Live research backend is not configured yet.";
    }

    return "The research request did not complete successfully.";
  }

  async function submitQuestion(event) {
    event.preventDefault();

    const payload = {
      branch: branchInput.value,
      question: questionField.value.trim()
    };

    if (!payload.question) {
      setStatus("Please add a question before generating the answer.");
      questionField.focus();
      return;
    }

    submitButton.disabled = true;
    sectionsToolbar.hidden = true;
    setStatus("Researching online sources…");
    trackEvent("question_submitted", { branch: payload.branch });
    const _t0 = Date.now();

    try {
      const response = await fetch("https://ep6az35owvnis2c6n6wcl7axyy0elrlh.lambda-url.eu-west-2.on.aws/", {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      const result = await response.json();
      const _ms = Date.now() - _t0;
      renderResult(result, getResponseStatusMessage(response, result));
      trackEvent("result_rendered", { branch: payload.branch, ms: _ms });
    } catch (error) {
      renderResult(
        {
          title: "Connection problem",
          summary: "The page could not reach the server research endpoint.",
          keyPoints: [
            "No client-side answer has been generated.",
            "The browser is waiting for a server-side research workflow.",
            "Until the backend is reachable, the site should fail clearly instead of guessing."
          ],
          sections: [
            {
              heading: "Next step",
              body: "Start the backend or wire a hosted research service that can search the web and return a branch-structured answer."
            }
          ]
        },
        "Server research endpoint unavailable."
      );
    } finally {
      submitButton.disabled = false;
    }
  }

  branchGrid.addEventListener("click", function (event) {
    const card = event.target.closest("[data-branch]");
    if (!card) {
      return;
    }
    selectBranch(card.getAttribute("data-branch"));
  });

  // ── Per-section thumbs (beta) ────────────────────────────────────────

  answerSections.addEventListener("click", function (e) {
    if (!ENABLE_SECTION_FEEDBACK) return;

    var btn = e.target.closest(".sfm-btn");
    if (!btn || btn.classList.contains("sfm-send")) return;

    var mini = btn.closest(".section-feedback-mini");
    if (!mini) return;

    if (mini.getAttribute("data-submitted") === "true") return;
    mini.setAttribute("data-submitted", "true");

    var section = mini.getAttribute("data-section") || "";
    var rating = btn.getAttribute("data-rating") || "";
    mini.setAttribute("data-rating", rating);

    trackEvent("section_feedback", {
      branch: branchInput.value || "",
      section: section,
      rating: rating
    });

    var sibling = rating === "up"
      ? mini.querySelector(".sfm-down")
      : mini.querySelector(".sfm-up");
    btn.classList.add("is-pressed");
    if (sibling) sibling.classList.add("is-dimmed");

    setTimeout(function () {
      var buttons = mini.querySelectorAll(".sfm-btn");
      buttons.forEach(function (b) { b.hidden = true; });
      var label = mini.querySelector(".sfm-label");
      if (label) label.hidden = true;
      var thanks = mini.querySelector(".sfm-thanks");
      if (thanks) thanks.hidden = false;
    }, 400);
  });

  // ── Bottom feedback form ─────────────────────────────────────────────

  var feedbackSubmitted = false;

  // Init feedback panel visibility (CSS flex overrides HTML hidden attribute)
  (function () {
    var fr = document.getElementById("feedback-form-row");
    var th = document.getElementById("feedback-thanks");
    if (fr) fr.style.display = "";
    if (th) th.style.display = "none";
  })();

  function resetFeedbackForm() {
    feedbackSubmitted = false;
    var formRow = document.getElementById("feedback-form-row");
    var thanks = document.getElementById("feedback-thanks");
    var textEl = document.getElementById("feedback-text");
    var emailEl = document.getElementById("feedback-email");
    if (formRow) formRow.style.display = "";
    if (thanks) thanks.style.display = "none";
    if (textEl) textEl.value = "";
    if (emailEl) emailEl.value = "";
  }

  // Delegated on document — same reliable pattern as per-section thumbs.
  document.addEventListener("click", function (e) {
    var btn = e.target.closest("#feedback-submit");
    if (!btn) return;

    e.preventDefault();
    var textEl = document.getElementById("feedback-text");
    var emailEl = document.getElementById("feedback-email");
    var text = (textEl ? textEl.value : "").trim().slice(0, 1000);
    var email = (emailEl ? emailEl.value : "").trim().slice(0, 120);

    trackEvent("feedback_submit", {
      branch: branchInput.value || "",
      text: text,
      email: email
    });

    var formRow = document.getElementById("feedback-form-row");
    var thanks = document.getElementById("feedback-thanks");
    if (formRow) formRow.style.display = "none";
    if (thanks) thanks.style.display = "";
  });

  form.addEventListener("submit", submitQuestion);
  selectBranch(branchInput.value);
  if (!ENABLE_PAYWALL) {
    premiumPanel.hidden = true;
  }

})();
