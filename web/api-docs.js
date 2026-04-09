(function () {
  "use strict";

  const docsStatus = document.getElementById("docs-status");
  const docsSummary = document.getElementById("docs-summary");
  const specTitle = document.getElementById("spec-title");
  const specDescription = document.getElementById("spec-description");
  const serverList = document.getElementById("server-list");
  const endpointList = document.getElementById("endpoint-list");

  function setStatus(message) {
    docsStatus.textContent = message;
  }

  function clearChildren(node) {
    node.replaceChildren();
  }

  function renderServers(servers) {
    clearChildren(serverList);
    (servers || []).forEach(function (server) {
      const item = document.createElement("li");
      item.textContent = server.description
        ? server.description + ": " + server.url
        : server.url;
      serverList.appendChild(item);
    });
  }

  function renderEndpoint(path, method, operation) {
    const article = document.createElement("article");
    article.className = "answer-section";

    const heading = document.createElement("h4");
    heading.textContent = method.toUpperCase() + " " + path;

    const summary = document.createElement("p");
    summary.textContent = operation.summary || "No summary provided.";

    const details = document.createElement("p");
    const responseCodes = Object.keys(operation.responses || {}).join(", ");
    details.textContent = "Operation: " + (operation.operationId || "n/a") + ". Responses: " + responseCodes + ".";

    article.appendChild(heading);
    article.appendChild(summary);
    article.appendChild(details);

    endpointList.appendChild(article);
  }

  async function loadSpec() {
    try {
      const response = await fetch("/openapi.json", {
        headers: {
          Accept: "application/json"
        }
      });

      if (!response.ok) {
        throw new Error("Spec request failed with status " + response.status + ".");
      }

      const spec = await response.json();
      specTitle.textContent = (spec.info && spec.info.title) || "School Scanner API";
      specDescription.textContent = (spec.info && spec.info.description) || "";
      renderServers(spec.servers || []);
      clearChildren(endpointList);

      Object.keys(spec.paths || {}).forEach(function (path) {
        const pathItem = spec.paths[path] || {};
        Object.keys(pathItem).forEach(function (method) {
          renderEndpoint(path, method, pathItem[method]);
        });
      });

      docsSummary.hidden = false;
      setStatus("OpenAPI contract loaded.");
    } catch (error) {
      setStatus("Could not load the OpenAPI document.");
      clearChildren(endpointList);

      const article = document.createElement("article");
      article.className = "answer-section";

      const heading = document.createElement("h4");
      heading.textContent = "OpenAPI unavailable";

      const body = document.createElement("p");
      body.textContent = error && error.message
        ? error.message
        : "The server did not return a readable OpenAPI document.";

      article.appendChild(heading);
      article.appendChild(body);
      endpointList.appendChild(article);
    }
  }

  loadSpec();
})();
