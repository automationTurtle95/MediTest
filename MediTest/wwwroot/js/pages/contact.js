      async function initSupport() {
        const user = await currentAuthUser(false);
        if (user?.email) document.getElementById("supportEmail").value = user.email;
      }

      document.getElementById("supportForm").addEventListener("submit", async (event) => {
        event.preventDefault();
        const button = document.getElementById("supportSubmit");
        const msg = document.getElementById("supportStatus");
        const payload = {
          category: document.getElementById("supportCategory").value,
          subject: document.getElementById("supportSubject").value.trim(),
          message: document.getElementById("supportMessage").value.trim(),
          includeDiagnostics: document.getElementById("supportDiagnostics").checked,
          currentPage: location.href,
          userAgent: navigator.userAgent,
        };
        status(msg, "Supportanfrage wird übermittelt...");
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        try {
          const result = await api("/api/support", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const ticket = result.ticketId ? ` Ticketnummer: ${result.ticketId}.` : "";
          status(msg, `${result.message || "Deine Supportanfrage wurde übermittelt."}${ticket}`, "status success");
          document.getElementById("supportSubject").value = "";
          document.getElementById("supportMessage").value = "";
        } catch (error) {
          status(msg, error.message, "status error");
        } finally {
          button.disabled = false;
          button.setAttribute("aria-busy", "false");
        }
      });

      initSupport().catch((error) => status(document.getElementById("supportStatus"), error.message, "status error"));
