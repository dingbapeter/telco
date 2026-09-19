// Fills in the network from the number's prefix as it is typed. The form
// works without this; it only saves a tap. Nothing here is required.
(function () {
  var inputs = document.querySelectorAll("input[data-network]");
  for (var i = 0; i < inputs.length; i++) {
    (function (input) {
      var select = document.getElementById(input.getAttribute("data-network"));
      if (!select) return;
      var last = "";
      input.addEventListener("input", function () {
        var digits = input.value.replace(/\D/g, "");
        if (digits.length < 4) return;
        var key = digits.slice(0, 6);
        if (key === last) return;
        last = key;
        fetch("/api/network-for?number=" + encodeURIComponent(input.value))
          .then(function (r) { return r.json(); })
          .then(function (d) { if (d.network && select.value === "") select.value = d.network; })
          .catch(function () {});
      });
    })(inputs[i]);
  }
})();

// iPhones refuse to dial a code with stars and hashes from a link, so on
// an iPhone the dial pad link is hidden and the copy instruction shown.
(function () {
  var iphone = /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.MSStream;
  var show = document.querySelectorAll(iphone ? ".iphone-only" : ".android-only");
  for (var i = 0; i < show.length; i++) show[i].style.display = "block";
  var buttons = document.querySelectorAll("button.copy");
  for (var j = 0; j < buttons.length; j++) {
    (function (button) {
      button.addEventListener("click", function () {
        var text = button.getAttribute("data-copy") || "";
        var done = function () { button.textContent = "Copied"; setTimeout(function () { button.textContent = "Copy the code"; }, 2000); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { fallback(text, done); });
        else fallback(text, done);
      });
    })(buttons[j]);
  }
  function fallback(text, done) {
    var box = document.createElement("textarea");
    box.value = text; box.setAttribute("readonly", ""); box.style.position = "absolute"; box.style.left = "-9999px";
    document.body.appendChild(box); box.select(); box.setSelectionRange(0, text.length);
    try { document.execCommand("copy"); done(); } catch (e) {}
    document.body.removeChild(box);
  }
})();
