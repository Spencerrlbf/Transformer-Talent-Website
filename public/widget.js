/* Transformer Talent job-board embed.
 * Usage: <script src="https://www.transformertalent.com/widget.js" data-org="acme"></script>
 * Renders the company's board in an auto-resizing iframe where the tag sits. */
(function () {
  var script = document.currentScript;
  if (!script) return;
  var org = script.getAttribute("data-org");
  if (!org || !/^[a-z0-9-]{2,60}$/.test(org)) {
    console.error("[tt-widget] missing or invalid data-org");
    return;
  }
  // Board origin = wherever this script was loaded from.
  var origin;
  try {
    origin = new URL(script.src).origin;
  } catch (e) {
    origin = "https://www.transformertalent.com";
  }
  var iframe = document.createElement("iframe");
  iframe.src = origin + "/board/" + org + "?embed=1";
  iframe.title = "Job board";
  iframe.style.width = "100%";
  iframe.style.border = "0";
  iframe.style.display = "block";
  iframe.style.minHeight = "480px";
  iframe.setAttribute("loading", "lazy");
  script.parentNode.insertBefore(iframe, script);

  window.addEventListener("message", function (e) {
    if (e.origin !== origin) return;
    var d = e.data;
    if (d && d.ttBoard === org && typeof d.height === "number") {
      iframe.style.height = Math.max(480, Math.ceil(d.height)) + "px";
    }
  });
})();
