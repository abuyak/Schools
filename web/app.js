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

  function setStatus(message) {
    formStatus.textContent = message;
  }

  function selectBranch(branch) {
    branchInput.value = branch;
    const cards = branchGrid.querySelectorAll("[data-branch]");
    cards.forEach(function (card) {
      const selected = card.getAttribute("data-branch") === branch;
      card.classList.toggle("is-selected", selected);
      card.setAttribute("aria-pressed", selected ? "true" : "false");
    });
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
      note.textContent = item.note || "";

      row.appendChild(dim);
      row.appendChild(badge);
      row.appendChild(note);
      scorecardEl.appendChild(row);
    });
    scorecardEl.hidden = false;
  }

  // Appends text to an element, turning markdown citations into real <a> elements.
  // Handles three formats the model may emit:
  //   ([label](url))   – wrapped in outer parens
  //   [label](url)     – plain markdown link
  //   [label]<url>     – angle-bracket URL variant
  // All non-link text is inserted as safe text nodes.
  function appendTextWithLinks(el, text) {
    // Group 1+2: ([label](url)) · Group 3+4: [label](url) · Group 5+6: [label]<url> (optional space before <)
    var pattern = /\(\[([^\]]+)\]\(([^)]+)\)\)|\[([^\]]+)\]\(([^)\s][^)]*)\)|\[([^\]]+)\]\s*<([^>]+)>/g;
    var lastIndex = 0;
    var match;

    while ((match = pattern.exec(text)) !== null) {
      if (match.index > lastIndex) {
        el.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }

      var label = match[1] || match[3] || match[5];
      var rawUrl = match[2] || match[4] || match[6];

      if (/^https?:\/\//i.test(rawUrl)) {
        var cleanUrl = rawUrl;
        try {
          var u = new URL(rawUrl);
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

      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      el.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  function renderBodyText(container, rawText) {
    container.replaceChildren();
    var lines = (rawText || "").split("\n")
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l.length > 0; });

    var currentList = null;
    var currentListType = null;

    lines.forEach(function (line) {
      var bulletMatch = line.match(/^[-*]\s+(.+)/);
      var numberedMatch = line.match(/^\d+[).]\s+(.+)/);

      if (bulletMatch) {
        if (currentListType !== "ul") {
          currentList = document.createElement("ul");
          container.appendChild(currentList);
          currentListType = "ul";
        }
        var li = document.createElement("li");
        appendTextWithLinks(li, bulletMatch[1]);
        currentList.appendChild(li);
      } else if (numberedMatch) {
        if (currentListType !== "ol") {
          currentList = document.createElement("ol");
          container.appendChild(currentList);
          currentListType = "ol";
        }
        var li = document.createElement("li");
        appendTextWithLinks(li, numberedMatch[1]);
        currentList.appendChild(li);
      } else {
        currentList = null;
        currentListType = null;
        var p = document.createElement("p");
        appendTextWithLinks(p, line);
        container.appendChild(p);
      }
    });
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
      renderResult(result, getResponseStatusMessage(response, result));
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
      const payload = {
        event: "donation_click",
        branch: branchInput.value || "",
        placement: coffeeCta.getAttribute("data-placement") || "results",
        utm_campaign: "donation",
        utm_content: "cta"
      };

      try {
        if (navigator.sendBeacon) {
          const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
          navigator.sendBeacon("/api/analytics/click", blob);
          return;
        }
      } catch (_error) {
        // fall through to fetch
      }

      fetch("/api/analytics/click", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(function () {
        // ignore analytics failures
      });
    });
  }

  form.addEventListener("submit", submitQuestion);
  selectBranch(branchInput.value);
  if (!ENABLE_PAYWALL) {
    premiumPanel.hidden = true;
  }
})();
