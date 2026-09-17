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
