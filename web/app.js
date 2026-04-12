(function () {
  "use strict";

  const ENABLE_PAYWALL = false;

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
  const answerSections = document.getElementById("answer-sections");
  const premiumPoints = document.getElementById("premium-points");
  const gateNote = document.getElementById("gate-note");
  const premiumPanel = document.getElementById("premium-panel");
  const coffeeCta = document.getElementById("coffee-cta");
  const feedbackCta = document.getElementById("feedback-cta");

  function setStatus(message) {
    formStatus.textContent = message;
  }

  // Fire-and-forget analytics event. Silently swallows all errors.
  function trackEvent(name, props) {
    try {
      var payload = Object.assign({ event: name }, props || {});
      if (navigator.sendBeacon) {
        try {
          navigator.sendBeacon("/api/analytics/click", new Blob([JSON.stringify(payload)], { type: "application/json" }));
          return;
        } catch (_e) {}
      }
      fetch("/api/analytics/click", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(function () {});
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
    table.className = "md-table";
    var headerCells = null;
    var tbody = null;

    tableLines.forEach(function (line, i) {
      if (isTableSeparator(line)) return;
      var cells = parseTableRow(line);
      if (i === 0) {
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
        cells.forEach(function (cell) {
          var td = document.createElement("td");
          appendTextWithLinks(td, cell);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
    });
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

      // Table row detection
      if (/^\|.+\|$/.test(line)) {
        inTable = true;
        currentList = null; currentListType = null;
        lastOlLi = null; nestedUl = null; groupList = null;
        tableLines.push(line);
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
      const article = document.createElement("article");
      article.className = "answer-section";

      const heading = document.createElement("h4");
      heading.textContent = section.heading || "";

      const body = document.createElement("div");
      body.className = "answer-section-body";
      renderBodyText(body, section.body || "");

      article.appendChild(heading);
      article.appendChild(body);
      answerSections.appendChild(article);
    });
  }

  function renderResult(result, modeLabel) {
    resultTitle.textContent = result.title || "Answer";
    resultSummary.textContent = result.summary || "";
    renderScorecard(result.scorecard || []);
    renderSections(result.sections || []);

    if (coffeeCta) {
      const status = result.status || "";
      const branch = branchInput.value || "";
      const utm = new URLSearchParams({
        utm_source: "school_scanner",
        utm_medium: "referral",
        utm_campaign: "donation",
        utm_content: status ? "answer_" + status : "answer"
      });

      if (branch) {
        utm.set("utm_term", branch);
      }

      const baseUrl = coffeeCta.getAttribute("data-base-url") || coffeeCta.href;
      try {
        const url = new URL(baseUrl);
        url.searchParams.forEach(function (_value, key) {
          if (utm.has(key)) {
            utm.delete(key);
          }
        });
        url.search = utm.toString();
        coffeeCta.href = url.toString();
      } catch (_error) {
        // If base URL is invalid, keep existing href.
      }
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
    setStatus("Researching online sources…");
    trackEvent("question_submitted", { branch: payload.branch });
    const _t0 = Date.now();

    try {
      const response = await fetch("/api/research", {
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

  if (coffeeCta) {
    coffeeCta.addEventListener("click", function () {
      trackEvent("cta_click", {
        branch: branchInput.value || "",
        placement: coffeeCta.getAttribute("data-placement") || "results"
      });
    });
  }

  if (feedbackCta) {
    feedbackCta.addEventListener("click", function () {
      trackEvent("feedback_click", {
        branch: branchInput.value || "",
        placement: feedbackCta.getAttribute("data-placement") || "results"
      });
    });
  }

  form.addEventListener("submit", submitQuestion);
  selectBranch(branchInput.value);
  if (!ENABLE_PAYWALL) {
    premiumPanel.hidden = true;
  }
})();
