"use strict";

const SITE_CONFIG = Object.freeze({
  brandName: "MediTest",
  purchasePrice: "9,99 €",
  monthlyPrice: "5,99 €",
  purchaseUrl: "./purchase.html"
});

const LEGAL_CONFIG = Object.freeze({
  operatorName: "Lukas Hofer",
  businessName: "MediTest",
  contactEmail: "lhofer9@gmail.com",
  postalAddress: "Lerchenweg 21b, 4203 Altenberg bei Linz",
  country: "Österreich"
});

document.querySelectorAll("[data-brand-name]").forEach((element) => {
  element.textContent = SITE_CONFIG.brandName;
});

document.querySelectorAll("[data-legal-field]").forEach((element) => {
  const value = LEGAL_CONFIG[element.dataset.legalField];
  element.textContent = value || "Vor Veröffentlichung ergänzen";
  element.classList.toggle("legal-field-missing", !value);
});

document.querySelectorAll("[data-contact-email]").forEach((link) => {
  if (LEGAL_CONFIG.contactEmail) {
    link.textContent = LEGAL_CONFIG.contactEmail;
    link.setAttribute("href", `mailto:${LEGAL_CONFIG.contactEmail}`);
    return;
  }

  link.textContent = "Kontaktadresse vor Veröffentlichung ergänzen";
  link.removeAttribute("href");
  link.setAttribute("aria-disabled", "true");
  link.classList.add("legal-field-missing");
});

document.querySelectorAll("[data-current-year]").forEach((element) => {
  element.textContent = String(new Date().getFullYear());
});

document.querySelectorAll("[data-purchase-price]").forEach((element) => {
  element.textContent = SITE_CONFIG.purchasePrice;
});

document.querySelectorAll("[data-monthly-price]").forEach((element) => {
  element.textContent = SITE_CONFIG.monthlyPrice;
});

document.querySelectorAll("[data-purchase-link]").forEach((link) => {
  link.setAttribute("href", SITE_CONFIG.purchaseUrl);
});

const header = document.querySelector("[data-header]");
const updateHeader = () => header?.classList.toggle("scrolled", window.scrollY > 16);
updateHeader();
window.addEventListener("scroll", updateHeader, { passive: true });

const navToggle = document.querySelector("[data-nav-toggle]");
const navigation = document.querySelector("[data-nav]");

const closeNavigation = () => {
  navToggle?.setAttribute("aria-expanded", "false");
  navigation?.classList.remove("open");
  document.body.classList.remove("nav-open");
};

navToggle?.addEventListener("click", () => {
  const isOpen = navToggle.getAttribute("aria-expanded") === "true";
  navToggle.setAttribute("aria-expanded", String(!isOpen));
  navigation?.classList.toggle("open", !isOpen);
  document.body.classList.toggle("nav-open", !isOpen);
});

navigation?.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", closeNavigation);
});

window.addEventListener("resize", () => {
  if (window.innerWidth > 820) closeNavigation();
});

const revealElements = document.querySelectorAll("[data-reveal]");

if ("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const revealObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("visible");
      observer.unobserve(entry.target);
    });
  }, {
    rootMargin: "0px 0px -8% 0px",
    threshold: 0.08
  });

  revealElements.forEach((element) => revealObserver.observe(element));
} else {
  revealElements.forEach((element) => element.classList.add("visible"));
}
