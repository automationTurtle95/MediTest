    let legalLicenseState = null;

    function valueOr(value, fallback = "Noch nicht konfiguriert") {
      return String(value || "").trim() || fallback;
    }
    function dateOr(value, fallback = "Unbefristet") {
      return value ? new Date(value).toLocaleDateString("de-AT") : fallback;
    }
    function legalLinkButton(label, url) {
      return url
        ? `<a class="button" href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`
        : `<button type="button" disabled>${esc(label)}</button>`;
    }
    function showImpressum() {
      const legal = legalLicenseState?.legal || {};
      const modal = document.createElement("div");
      modal.className = "modal-backdrop";
      modal.id = "impressumModal";
      modal.innerHTML = `<section class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="impressumTitle">
  <p class="eyebrow">Rechtlicher Hinweis</p>
  <h2 id="impressumTitle">Impressum</h2>
  <p>${esc(valueOr(legal.impressumText))}</p>
  <div class="actions">${legal.impressumUrl ? `<a class="button primary" href="${esc(legal.impressumUrl)}" target="_blank" rel="noopener">Impressum öffnen</a>` : ""}<button type="button" onclick="document.getElementById('impressumModal')?.remove()">Schließen</button></div>
</section>`;
      document.body.appendChild(modal);
    }

    function renderLegalLicense(data) {
      legalLicenseState = data;
      const legal = data.legal || {};
      const access = data.access || {};
      const license = access.license || {};
      const user = access.user || {};
      const result = access.result || {};
      const config = access.appConfig || {};
      const device = access.device || {};
      const statusClass = result.isValid ? "status success" : "status error";
      document.getElementById("msg").className = statusClass;
      document.getElementById("msg").textContent = result.message || "Lizenzstatus unbekannt.";
      document.getElementById("legalLicenseBox").innerHTML = `
  <article class="card doc-card">
    <span class="badge">${esc(result.status || "unbekannt")}</span>
    <h2>Deine Lizenz &amp; Geräte</h2>
    <p class="muted">Ein gekaufter Zugang kann auf bis zu ${Number(license.maxDevices) || 3} Geräten aktiviert werden.</p>
    <dl class="legal-details">
      <div><dt>Nutzer</dt><dd>${esc(valueOr(user.displayName, user.email || "-"))}</dd></div>
      <div><dt>E-Mail</dt><dd>${esc(valueOr(user.email, "-"))}</dd></div>
      <div><dt>Lizenztyp</dt><dd>${esc(valueOr(license.licenseType, "-"))}</dd></div>
      <div><dt>Lizenzstatus</dt><dd>${esc(valueOr(license.licenseStatus, "-"))}</dd></div>
      <div><dt>Gültig bis</dt><dd>${esc(dateOr(license.licenseEndDate))}</dd></div>
      <div><dt>Geräte</dt><dd>${Number(license.currentDeviceCount) || 0} / ${Number(license.maxDevices) || 0}</dd></div>
      <div><dt>Dieses Gerät</dt><dd>${result.deviceActivated ? "Aktiviert" : "Nicht aktiviert"}</dd></div>
      <div><dt>Prüfmodus</dt><dd>${access.isOfflineMode ? "Offline-Cache" : "Online"}</dd></div>
    </dl>
    <div class="actions">
      <button class="primary" type="button" onclick="checkLicense()">Lizenz prüfen</button>
      <button type="button" onclick="activateDevice()" ${result.deviceActivated || !result.canActivateDevice ? "disabled" : ""}>${result.deviceActivated ? "Gerät aktiviert" : "Gerät aktivieren"}</button>
      <button type="button" onclick="logoutApp()">Abmelden</button>
    </div>
    <div id="deviceListSection" style="margin-top:20px">
      <h3 style="font-size:15px;margin:0 0 10px">Aktivierte Geräte</h3>
      <div id="deviceListContent"><p class="muted" style="font-size:13px">Lade Geräteliste...</p></div>
    </div>
  </article>
  <details class="card legal-info-panel">
    <summary>
      <span>Produkt, Kontakt &amp; rechtliche Links</span>
      <small>Zusätzliche Informationen anzeigen</small>
    </summary>
    <div class="legal-info-content">
      <div>
        <h2>Produkt</h2>
        <dl class="legal-details">
          <div><dt>Produkt</dt><dd>${esc(legal.productName || APP_BRAND.productName)}</dd></div>
          <div><dt>Version</dt><dd>${esc(valueOr(legal.productVersion, "-"))}</dd></div>
          <div><dt>Buildnummer</dt><dd>${esc(valueOr(legal.buildNumber, "-"))}</dd></div>
          <div><dt>Veröffentlichung</dt><dd>${esc(dateOr(legal.releaseDate, "-"))}</dd></div>
          <div><dt>Entwickler</dt><dd>${esc(valueOr(legal.developerName, "Lukas Hofer"))}</dd></div>
          <div><dt>Rechteinhaber</dt><dd>${esc(valueOr(legal.legalOwner, "Lukas Hofer"))}</dd></div>
          <div><dt>Land</dt><dd>${esc(valueOr(legal.country, "Österreich"))}</dd></div>
        </dl>
        <p class="muted">${esc(valueOr(legal.copyrightText))}</p>
      </div>
      <div>
        <h2>Kontakt &amp; Rechtliches</h2>
        <p><strong>Support:</strong> <a href="mailto:${esc(valueOr(config.supportEmail || legal.supportEmail))}">${esc(valueOr(config.supportEmail || legal.supportEmail))}</a></p>
        <p><a class="button primary" href="/pages/contact.html">Supportformular öffnen</a></p>
        <p class="muted">${esc(valueOr(legal.legalDisclaimerText, "Die finalen Rechtstexte werden separat juristisch geprüft."))}</p>
        <div class="actions">
          <button type="button" onclick="showImpressum()">Impressum anzeigen</button>
          ${legalLinkButton("Datenschutz öffnen", config.privacyPolicyUrl || legal.privacyPolicyUrl)}
          ${legalLinkButton("AGB öffnen", config.termsOfUseUrl || legal.termsOfUseUrl)}
          ${legalLinkButton("Lizenzbedingungen öffnen", config.licenseAgreementUrl || legal.licenseAgreementUrl)}
        </div>
      </div>
    </div>
    ${Array.isArray(legal.configurationWarnings) && legal.configurationWarnings.length ? `<div class="status error">${legal.configurationWarnings.map(esc).join("<br>")}</div>` : ""}
  </details>`;
    }

    function renderBilling(s) {
      const trialEnd = dateOr(s.trialEndsAt, "-");
      const purchaseDate = dateOr(s.baseProductPurchasedAt, "-");
      const isPremium = s.premiumActive || s.status === "premium";
      const hasSubscription = !!s.subscriptionActive && !isPremium;
      const isRestricted = !!s.restrictedMode || s.status === "restricted";
      const productPurchased = !!s.baseProductPurchased;
      const fullAccess = isPremium || hasSubscription || s.status === "trial";
      const testsAvailable = productPurchased || fullAccess;
      const freeCreditAvailable = !!s.freeCatalogCreditAvailable;
      const freeCreditRedeemed = !!s.freeCatalogCreditRedeemed;
      const freeCreditText = freeCreditAvailable
        ? "Aktiv: Wähle im Katalog einen gesperrten Test und nutze „Gratis-Test verwenden“."
        : freeCreditRedeemed
          ? `Bereits verwendet für Katalogtest ${esc(s.freeCatalogCreditRedeemedCatalogId || "")}.`
          : "Noch nicht aktiviert.";
      document.getElementById("billingBox").innerHTML = `
  <article class="card doc-card license-plan-card">
    <span class="badge">${isRestricted ? "Eingeschränkt" : "Zugang"}</span>
    <h2>${esc(s.plan)}</h2>
    <p class="muted">${
      isPremium
        ? "Dauerhaft freigeschaltet"
        : hasSubscription
          ? `Monatsabo aktiv · ${priceLabel(s.monthlyPriceCents, s.currency)} pro Monat`
          : s.status === "trial"
            ? `Testphase bis ${trialEnd} · ${Number(s.trialDaysRemaining) || 0} Tag(e) übrig`
            : productPurchased
              ? `Basiskauf am ${purchaseDate}`
              : `Einmaliger Kauf: ${priceLabel(s.productPriceCents, s.currency)}`
    }</p>
    <p>${
      isPremium
        ? "Premium ist aktiv. Katalogfreischaltungen per Premium-Code sind eine gesonderte Sonderberechtigung."
        : hasSubscription
          ? `Alle ${APP_BRAND.productName}-Funktionen sind verfügbar. Katalogtests bleiben separate Kaufartikel.`
          : s.status === "trial"
            ? `Der Kauf enthält 7 Tage Vollzugang. Danach kostet das optionale Abo <b>${priceLabel(s.monthlyPriceCents, s.currency)} pro Monat</b>. Katalogtests sind nicht enthalten.`
            : isRestricted
              ? `Tests aus vorhandenen Fragenpools können gestartet, fortgesetzt und ausgewertet werden. Dokument-, Fragen-, Katalog-, Statistik-, Bearbeitungs- und KI-Funktionen werden mit dem Abo für <b>${priceLabel(s.monthlyPriceCents, s.currency)} pro Monat</b> wieder freigeschaltet.`
              : `${APP_BRAND.productName} muss zuerst einmalig für <b>${priceLabel(s.productPriceCents, s.currency)}</b> gekauft werden. Der Kauf startet die 7-tägige Testphase und schaltet den Installer frei.`
    }</p>
    <div class="actions">${
      isPremium
        ? '<button class="primary" type="button" disabled>Premium aktiv</button>'
        : hasSubscription
          ? '<button class="primary" type="button" onclick="manageSubscription()">Premium-Abo verwalten</button>'
          : productPurchased
            ? `<button class="primary" type="button" onclick="startSubscription()" ${s.checkoutConfigured ? "" : "disabled"}>Premium-Abo kaufen · ${priceLabel(s.monthlyPriceCents, s.currency)}/Monat</button>`
            : `<a class="button primary" href="${APP_BRAND.websiteUrl}/purchase" target="_blank" rel="noopener">${APP_BRAND.productName} kaufen</a>`
    }</div>
  </article>
  <article class="card doc-card">
    <span class="badge">Deine Funktionen</span>
    <h2>${isRestricted ? "Tests bleiben verfügbar" : fullAccess ? "Voller Funktionsumfang" : "Nach dem Kauf verfügbar"}</h2>
    <ul class="license-feature-list">
      <li class="${testsAvailable ? "available" : "locked"}"><strong>Tests durchführen &amp; auswerten</strong><span>${testsAvailable ? "Verfügbar" : "Nach dem Kauf verfügbar"}</span></li>
      <li class="${fullAccess ? "available" : "locked"}"><strong>Dokumente &amp; Fragenpools verwalten</strong><span>${fullAccess ? "Verfügbar" : isRestricted ? "Premium erforderlich" : "Nach dem Kauf verfügbar"}</span></li>
      <li class="${fullAccess ? "available" : "locked"}"><strong>KI-Fragen erstellen</strong><span>${fullAccess ? "Verfügbar" : isRestricted ? "Premium erforderlich" : "Nach dem Kauf verfügbar"}</span></li>
      <li class="${fullAccess ? "available" : "locked"}"><strong>Katalog &amp; Statistik öffnen</strong><span>${fullAccess ? "Verfügbar" : isRestricted ? "Premium erforderlich" : "Nach dem Kauf verfügbar"}</span></li>
    </ul>
    ${isRestricted ? `<p class="muted">Nach Ablauf der Testphase können vorhandene Tests weiterhin gestartet, fortgesetzt und ausgewertet werden. Alle anderen Funktionen werden mit Premium wieder freigeschaltet.</p>` : ""}
  </article>
  <article class="card doc-card">
    <span class="badge">Katalog</span>
    <h2>Separate Kaufartikel</h2>
    <p class="muted">Katalogtests sind weder im Basiskauf noch in der Testphase oder im Monatsabo enthalten.</p>
    <p>Ein gekaufter und bereits heruntergeladener Katalogtest bleibt als vorhandener Fragenpool für Testdurchläufe nutzbar. Der Katalog selbst erfordert nach der Testphase ein aktives Abo.</p>
    <div class="actions"><a class="button primary" href="/pages/catalog.html">Katalog öffnen</a></div>
  </article>
  <article class="card doc-card">
    <span class="badge">Gratis-Test</span>
    <h2>Katalog-Code</h2>
    <p class="muted">${freeCreditText}</p>
    <form onsubmit="redeemCatalogCode(event)">
      <label for="catalogCode">Gratis-Katalog-Code</label>
      <input type="text" id="catalogCode" autocomplete="off" placeholder="Gratis-Katalog-Code eingeben" ${freeCreditAvailable || freeCreditRedeemed ? "disabled" : ""}>
      <div class="actions">${freeCreditAvailable ? '<a class="button primary" href="/pages/catalog.html">Gratis-Test auswählen</a>' : `<button class="primary" type="submit" ${freeCreditRedeemed ? "disabled" : ""}>Code einlösen</button>`}</div>
    </form>
  </article>
  <article class="card doc-card">
    <span class="badge">Premium-Code</span>
    <h2>Code einlösen</h2>
    <p class="muted">Ein gültiger administrativer Code schaltet die Meduvalo-Vollfunktionen frei. Katalogtests bleiben separate Kaufartikel.</p>
    <form onsubmit="redeemPremiumCode(event)">
      <label for="premiumCode">Premium-Code</label>
      <input type="text" id="premiumCode" autocomplete="off" placeholder="MT-PREMIUM-XXXX-XXXX-XXXX-XXXX" ${isPremium ? "disabled" : ""}>
      <div class="actions"><button class="primary" type="submit" ${isPremium ? "disabled" : ""}>Code einlösen</button></div>
    </form>
  </article>`;
    }

    async function loadLicense() {
      const [legal, billing] = await Promise.all([api("/api/legal-license/status"), api("/api/license/status")]);
      renderLegalLicense(legal);
      renderBilling(billing);
      if (legal.access?.result?.requiresTermsAcceptance) showTermsAcceptanceModal(legal);
      enhanceTooltips();
    }
    async function checkLicense() {
      status(document.getElementById("msg"), "Prüfe Lizenz...");
      try {
        renderLegalLicense({
          legal: legalLicenseState.legal,
          access: await api("/api/legal-license/check", { method: "POST" }),
        });
      } catch (e) {
        status(document.getElementById("msg"), e.message, "status error");
      }
    }
    async function activateDevice() {
      status(document.getElementById("msg"), "Aktiviere Gerät...");
      try {
        renderLegalLicense({
          legal: legalLicenseState.legal,
          access: await api("/api/legal-license/device", { method: "POST" }),
        });
      } catch (e) {
        status(document.getElementById("msg"), e.message, "status error");
      }
    }
    async function manageSubscription() {
      try {
        const r = await api("/api/license/portal", { method: "POST" });
        if (r.available && r.url) location.href = r.url;
        else status(document.getElementById("msg"), r.message, "status error");
      } catch (e) {
        status(document.getElementById("msg"), e.message, "status error");
      }
    }
    async function startSubscription() {
      try {
        const r = await api("/api/license/checkout/subscription", { method: "POST" });
        if (r.available && r.url) location.href = r.url;
        else status(document.getElementById("msg"), r.message, "status error");
      } catch (e) {
        status(document.getElementById("msg"), e.message, "status error");
      }
    }
    async function redeemPremiumCode(e) {
      e.preventDefault();
      const code = document.getElementById("premiumCode").value.trim();
      if (!code) {
        status(document.getElementById("msg"), "Bitte gib einen Premium-Code ein.", "status error");
        return;
      }
      try {
        const r = await api("/api/license/redeem-premium-code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });
        status(document.getElementById("msg"), r.message || "Premium wurde aktiviert.", "status success");
        await loadLicense();
      } catch (err) {
        status(document.getElementById("msg"), err.message, "status error");
      }
    }
    async function redeemCatalogCode(e) {
      e.preventDefault();
      const code = document.getElementById("catalogCode").value.trim();
      if (!code) {
        status(document.getElementById("msg"), "Bitte gib einen Gratis-Katalog-Code ein.", "status error");
        return;
      }
      try {
        await api("/api/license/redeem-catalog-code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });
        status(document.getElementById("msg"), "Gratis-Test aktiviert.", "status success");
        await loadLicense();
      } catch (err) {
        status(document.getElementById("msg"), err.message, "status error");
      }
    }

    async function loadDeviceList() {
      const box = document.getElementById("deviceListContent");
      if (!box) return;
      try {
        const data = await api("/api/legal-license/devices");
        const devices = data.devices || [];
        if (!devices.length) {
          box.innerHTML = '<p class="muted" style="font-size:13px">Keine Geräte gefunden.</p>';
          return;
        }
        box.innerHTML = devices.map(d => {
          const lastUsed = d.lastUsedAt ? new Date(d.lastUsedAt).toLocaleDateString("de-AT") : "-";
          const isCurrent = d.isCurrent;
          return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);flex-wrap:wrap">
            <div style="min-width:0">
              <div style="font-weight:700;font-size:14px">${esc(d.deviceName)}${isCurrent ? ' <span class="badge" style="font-size:11px;margin-left:4px">Dieses Gerät</span>' : ""}</div>
              <div class="muted" style="font-size:12px">v${esc(d.appVersion)} · Zuletzt: ${lastUsed}</div>
            </div>
            ${isCurrent ? "" : `<button type="button" style="flex-shrink:0;font-size:13px;padding:6px 14px;color:var(--danger);border-color:var(--danger)" onclick="removeDevice('${esc(d.deviceId)}', '${esc(d.deviceName)}')">Entfernen</button>`}
          </div>`;
        }).join("") + '<div style="border-bottom:none"></div>';
      } catch (e) {
        box.innerHTML = `<p class="muted" style="font-size:13px">Geräteliste konnte nicht geladen werden.</p>`;
      }
    }

    async function removeDevice(deviceId, deviceName) {
      if (!confirm(`Gerät „${deviceName}" aus der Lizenz entfernen?\n\nDas Gerät kann jederzeit wieder aktiviert werden.`)) return;
      const msg = document.getElementById("msg");
      status(msg, "Entferne Gerät...");
      try {
        await api("/api/legal-license/device/remove", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceId })
        });
        status(msg, "Gerät wurde entfernt.", "status success");
        await Promise.all([loadLicense(), loadDeviceList()]);
      } catch (e) {
        status(msg, e.message, "status error");
      }
    }

    async function initLicense() {
      const checkout = new URLSearchParams(location.search).get("checkout");
      await loadLicense();
      loadDeviceList();
      if (checkout === "success") {
        status(
          document.getElementById("msg"),
          "Zahlung erfolgreich. Die Freischaltung wird mit Stripe abgeglichen...",
          "status success",
        );
        setTimeout(() => loadLicense().catch(() => {}), 2500);
      } else if (checkout === "cancelled") {
        status(document.getElementById("msg"), "Checkout abgebrochen. Es wurde nichts geändert.", "status");
      }
    }
    initLicense().catch((e) => status(document.getElementById("msg"), e.message, "status error"));
