(function () {
  "use strict";

  const ENABLE_PAYWALL = false;

  const form = document.getElementById("question-form");
  const branchInput = document.getElementById("branch-input");
  const branchGrid = document.getElementById("branch-grid");
  const questionField = document.getElementById("question");
  const emailField = document.getElementById("email");
  const submitButton = document.getElementById("submit-button");
  const formStatus = document.getElementById("form-status");
  const resultCard = document.getElementById("result-card");
  const resultTitle = document.getElementById("result-title");
  const resultSummary = document.getElementById("result-summary");
  const previewPoints = document.getElementById("preview-points");
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

  function renderSections(sections) {
    answerSections.replaceChildren();
    (sections || []).forEach(function (section) {
      const article = document.createElement("article");
      article.className = "answer-section";

      const heading = document.createElement("h4");
      heading.textContent = section.heading || "";

      const body = document.createElement("p");
      body.textContent = section.body || "";

      article.appendChild(heading);
      article.appendChild(body);
      answerSections.appendChild(article);
    });
  }

  function renderResult(result, modeLabel) {
    resultTitle.textContent = result.title || "Answer";
    resultSummary.textContent = result.summary || "";
    renderList(previewPoints, result.keyPoints || []);
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
      question: questionField.value.trim(),
      email: emailField.value.trim()
    };

    if (!payload.question) {
      setStatus("Please add a question before generating the answer.");
      questionField.focus();
      return;
    }

    submitButton.disabled = true;
    setStatus("Researching online sources. This should take longer than the old instant local path.");

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
