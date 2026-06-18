      const form = document.getElementById("authForm");
      const msg = document.getElementById("msg");
      const loginTab = document.getElementById("loginTab");
      const registerTab = document.getElementById("registerTab");
      const title = document.getElementById("formTitle");
      const submitBtn = document.getElementById("submitBtn");
      const displayNameWrap = document.getElementById("displayNameWrap");
      const authHint = document.getElementById("authHint");
      const loginSuccess = document.getElementById("loginSuccess");
      const resetPasswordBtn = document.getElementById("resetPasswordBtn");
      const resendVerificationBtn = document.getElementById("resendVerificationBtn");
      const socialAuth = document.getElementById("socialAuth");
      const googleLoginBtn = document.getElementById("googleLoginBtn");
      const appleLoginBtn = document.getElementById("appleLoginBtn");
      let mode = "login";
      let loginRedirectTimer = null;

      function safeReturnUrl() {
        const value = qs("returnUrl") || "/pages/documents.html";
        if (!value.startsWith("/") || value.startsWith("//")) return "/pages/documents.html";
        if (value.includes("/pages/login.html")) return "/pages/documents.html";
        return value;
      }
      function setMode(next) {
        mode = next;
        const registering = mode === "register";
        loginTab.classList.toggle("active", !registering);
        registerTab.classList.toggle("active", registering);
        displayNameWrap.classList.toggle("hidden", !registering);
        title.textContent = registering ? "Konto erstellen" : "Einloggen";
        submitBtn.textContent = registering ? "Registrieren" : "Einloggen";
        resetPasswordBtn.classList.toggle("hidden", registering);
        resendVerificationBtn.classList.add("hidden");
        document.getElementById("password").autocomplete = registering ? "new-password" : "current-password";
        msg.classList.add("hidden");
      }
      async function loadConfig() {
        try {
          const cfg = await getAuthConfig(true);
          const googleEnabled = cfg.firebase?.googleEnabled === true;
          const appleEnabled = cfg.firebase?.appleEnabled === true;
          authHint.textContent = cfg.cloudConfigured
            ? "Melde dich mit E-Mail, Google oder Apple an."
            : "Die Anmeldung ist noch nicht vollständig konfiguriert.";
          registerTab.classList.toggle("hidden", !cfg.registrationEnabled);
          googleLoginBtn.classList.toggle("hidden", !googleEnabled);
          appleLoginBtn.classList.toggle("hidden", !appleEnabled);
          socialAuth.classList.toggle("hidden", !googleEnabled && !appleEnabled);
        } catch (e) {}
      }
      async function completeLogin(res) {
        status(msg, `Willkommen, ${res.user.displayName || res.user.email}.`, "status success");
        loginSuccess.classList.remove("hidden");
        setTimeout(async () => {
          loginSuccess.classList.add("hidden");
          window.mediTestPostUpdateRedirect = safeReturnUrl();
          const updateInfo = await checkForAppUpdatePopup();
          if (updateInfo?.updateAvailable) return;
          loginRedirectTimer = setTimeout(() => {
            location.href = safeReturnUrl();
          }, 350);
        }, 1450);
      }
      async function providerLogin(providerId) {
        const label = providerId === "apple.com" ? "Apple" : "Google";
        try {
          googleLoginBtn.disabled = true;
          appleLoginBtn.disabled = true;
          status(msg, `${label}-Anmeldung wird geöffnet...`);
          const res = await loginWithFirebaseProvider(providerId);
          await completeLogin(res);
        } catch (error) {
          status(msg, error.message, "status error");
        } finally {
          googleLoginBtn.disabled = false;
          appleLoginBtn.disabled = false;
        }
      }
      loginTab.onclick = () => setMode("login");
      registerTab.onclick = () => setMode("register");
      googleLoginBtn.onclick = () => providerLogin("google.com");
      appleLoginBtn.onclick = () => providerLogin("apple.com");
      resetPasswordBtn.onclick = async () => {
        const email = document.getElementById("email").value.trim();
        try {
          status(msg, "Sende E-Mail zum Zurücksetzen...");
          const r = await sendFirebasePasswordReset(email);
          status(msg, r.message, "status success");
        } catch (err) {
          status(msg, err.message, "status error");
        }
      };
      resendVerificationBtn.onclick = async () => {
        try {
          status(msg, "Sende Bestätigungs-E-Mail...");
          const r = await resendFirebaseEmailVerification({
            email: document.getElementById("email").value.trim(),
            password: document.getElementById("password").value,
          });
          status(msg, r.message, "status success");
          if (r.verified) resendVerificationBtn.classList.add("hidden");
        } catch (err) {
          status(msg, err.message, "status error");
        }
      };
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const payload = {
          email: document.getElementById("email").value.trim(),
          password: document.getElementById("password").value,
          displayName: document.getElementById("displayName").value.trim(),
        };
        try {
          status(msg, mode === "register" ? "Konto wird erstellt..." : "Anmeldung läuft...");
          const res = mode === "register" ? await registerWithFirebase(payload) : await loginWithFirebase(payload);
          if (res.verificationRequired) {
            setMode("login");
            document.getElementById("email").value = res.email || payload.email;
            document.getElementById("password").value = "";
            resendVerificationBtn.classList.remove("hidden");
            status(msg, res.message, "status success");
            return;
          }
          await completeLogin(res);
        } catch (err) {
          resendVerificationBtn.classList.toggle("hidden", err?.emailVerificationRequired !== true);
          status(msg, err.message, "status error");
        }
      });
      currentAuthUser(false)
        .then((user) => {
          if (user) location.href = safeReturnUrl();
        })
        .catch(() => {});
      loadConfig();
      fetch("/api/app/info")
        .then((r) => r.json())
        .then((d) => {
          const el = document.getElementById("appVersion");
          if (el && d.version) el.textContent = "Version " + d.version;
        })
        .catch(() => {});
      if (qs("verificationRequired") === "1") {
        resendVerificationBtn.classList.remove("hidden");
        status(msg, "Bitte bestätige zuerst deine E-Mail-Adresse.", "status error");
      }
      if (qs("accountDeleted") === "1") {
        status(msg, qs("message") || "Konto und zugehörige Daten wurden gelöscht.", "status success");
      }
      enhanceTooltips();
