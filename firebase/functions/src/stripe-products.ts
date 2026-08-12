import { createHash } from "node:crypto";
import { Firestore, Timestamp } from "firebase-admin/firestore";
import Stripe from "stripe";

export type CommerceProductKind = "base-product" | "subscription" | "catalog";

export type CommerceProduct = {
  localProductKey: string;
  productKind: CommerceProductKind;
  catalogId: string;
  catalogCollection: string;
  name: string;
  description: string;
  stripeProductId: string;
  stripePriceId: string;
  currency: string;
  priceAmount: number;
  taxCode: string;
  active: boolean;
  recurringInterval: "month" | "";
  recurringIntervalCount: number;
};

export type StripeProductConfig = {
  productPriceAmount: number;
  monthlyPriceAmount: number;
  semesterPriceAmount: number;
  catalogQuestionPriceAmount: number;
  catalogPriceEndingAmount: number;
  currency: string;
};

export type StripeValidationIssue = {
  severity: "error" | "warning";
  code: string;
  localProductKey: string;
  message: string;
};

export type StripeValidationAction = {
  action: "reused" | "created-product" | "created-price" | "saved-mapping";
  localProductKey: string;
  stripeProductId: string;
  stripePriceId: string;
  message: string;
};

export type StripeValidationProduct = CommerceProduct & {
  valid: boolean;
  issues: StripeValidationIssue[];
};

export type StripeValidationReport = {
  valid: boolean;
  repairRequested: boolean;
  checkedAt: string;
  stripeMode: "live" | "test";
  products: StripeValidationProduct[];
  issues: StripeValidationIssue[];
  actions: StripeValidationAction[];
};

export class StripeProductConfigurationError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "StripeProductConfigurationError";
  }
}

export async function loadCommerceProducts(
  db: Firestore,
  config: StripeProductConfig
): Promise<CommerceProduct[]> {
  const mappings = new Map<string, Record<string, unknown>>();
  const mappingSnapshot = await db.collection("commerceProducts").get();
  mappingSnapshot.docs.forEach((document) => {
    const data = document.data();
    const key = stringValue(data.localProductKey);
    if (key) mappings.set(key, data);
  });

  const base = mergeMapping({
    localProductKey: "base-product",
    productKind: "base-product",
    catalogId: "",
    catalogCollection: "",
    name: "Meduvalo für Windows und macOS",
    description: "Einmaliger Kauf der Meduvalo Desktop-Software für Windows und macOS",
    stripeProductId: "",
    stripePriceId: "",
    currency: normalizeCurrency(config.currency),
    priceAmount: positiveInt(config.productPriceAmount),
    taxCode: "",
    active: true,
    recurringInterval: "",
    recurringIntervalCount: 0
  }, mappings.get("base-product"));

  const subscription = mergeMapping({
    localProductKey: "subscription-monthly",
    productKind: "subscription",
    catalogId: "",
    catalogCollection: "",
    name: "Meduvalo Pro (Monat)",
    description: "Monatlicher Vollzugang zu Meduvalo (Pro)",
    stripeProductId: "",
    stripePriceId: "",
    currency: normalizeCurrency(config.currency),
    priceAmount: positiveInt(config.monthlyPriceAmount),
    taxCode: "",
    active: true,
    recurringInterval: "month",
    recurringIntervalCount: 1
  }, mappings.get("subscription-monthly"));

  const semester = mergeMapping({
    localProductKey: "subscription-semester",
    productKind: "subscription",
    catalogId: "",
    catalogCollection: "",
    name: "Meduvalo Semesterpass",
    description: "Vollzugang zu Meduvalo für 6 Monate (Semesterpass)",
    stripeProductId: "",
    stripePriceId: "",
    currency: normalizeCurrency(config.currency),
    priceAmount: positiveInt(config.semesterPriceAmount),
    taxCode: "",
    active: true,
    recurringInterval: "month",
    recurringIntervalCount: 6
  }, mappings.get("subscription-semester"));

  const catalogProducts: CommerceProduct[] = [];
  for (const collection of ["catalogTests", "thematicTests"]) {
    const snapshot = await db.collection(collection).get();
    for (const document of snapshot.docs) {
      const data = document.data();
      const questionCount = catalogQuestionCount(data);
      if (!questionCount) continue;
      const catalogId = document.id;
      const localProductKey = `catalog:${catalogId}`;
      const category = stringValue(data.category) || "Allgemein";
      const configuredAmount = positiveInt(data.priceAmount) || positiveInt(data.priceCents);
      const calculatedAmount = category.toLowerCase() === "medat"
        ? 4999
        : questionCount * Math.max(0, config.catalogQuestionPriceAmount) +
          Math.max(0, config.catalogPriceEndingAmount);
      const product = mergeMapping({
        localProductKey,
        productKind: "catalog",
        catalogId,
        catalogCollection: collection,
        name: stringValue(data.title) || "Meduvalo Katalogtest",
        description: stringValue(data.description) ||
          `Meduvalo Katalogtest mit ${questionCount} Fragen`,
        stripeProductId: stringValue(data.stripeProductId),
        stripePriceId: stringValue(data.stripePriceId),
        currency: normalizeCurrency(stringValue(data.currency) || config.currency),
        priceAmount: configuredAmount || calculatedAmount,
        taxCode: stringValue(data.taxCode),
        active: data.active !== false,
        recurringInterval: "",
        recurringIntervalCount: 0
      }, mappings.get(localProductKey));
      catalogProducts.push(product);
    }
  }

  return [base, subscription, semester, ...catalogProducts]
    .sort((left, right) => left.localProductKey.localeCompare(right.localProductKey));
}

export async function resolveCommerceProduct(
  db: Firestore,
  config: StripeProductConfig,
  kind: CommerceProductKind,
  catalogId = "",
  plan: "monthly" | "semester" = "monthly"
): Promise<CommerceProduct> {
  const key = kind === "catalog" ? `catalog:${catalogId}` :
    kind === "subscription" ? `subscription-${plan}` : "base-product";
  const products = await loadCommerceProducts(db, config);
  const product = products.find((candidate) => candidate.localProductKey === key);
  if (!product) {
    throw new StripeProductConfigurationError(
      "local_product_missing",
      "Das lokale Kaufprodukt wurde nicht gefunden."
    );
  }
  return product;
}

export async function resolveCommerceProductByPriceId(
  db: Firestore,
  config: StripeProductConfig,
  stripePriceId: string
): Promise<CommerceProduct | null> {
  if (!stripePriceId) return null;
  const products = await loadCommerceProducts(db, config);
  return products.find((product) => product.stripePriceId === stripePriceId) ?? null;
}

export async function assertStripeCheckoutProduct(
  stripe: InstanceType<typeof Stripe>,
  product: CommerceProduct
): Promise<{ price: any; stripeProduct: any }> {
  if (!product.active) {
    throw new StripeProductConfigurationError(
      "local_product_inactive",
      `Das Produkt "${product.name}" ist lokal inaktiv.`
    );
  }
  if (!product.stripeProductId || !product.stripePriceId) {
    throw new StripeProductConfigurationError(
      "stripe_mapping_missing",
      `Für "${product.name}" fehlt eine gültige Stripe-Produkt- oder Preiszuordnung.`
    );
  }

  let price: any;
  try {
    price = await stripe.prices.retrieve(product.stripePriceId, {
      expand: ["product"]
    });
  } catch (error: any) {
    throw new StripeProductConfigurationError(
      "stripe_price_missing",
      `Der Stripe-Preis ${product.stripePriceId} für "${product.name}" ist nicht verfügbar: ${stringValue(error?.message)}`
    );
  }

  const stripeProduct = typeof price.product === "string" ? null : price.product;
  if (!stripeProduct || stripeProduct.deleted) {
    throw new StripeProductConfigurationError(
      "stripe_product_missing",
      `Das Stripe-Produkt für "${product.name}" ist nicht verfügbar.`
    );
  }
  if (stripeProduct.id !== product.stripeProductId) {
    throw new StripeProductConfigurationError(
      "stripe_product_mismatch",
      `Der Stripe-Preis für "${product.name}" gehört zu einem anderen Stripe-Produkt.`
    );
  }
  if (!price.active || !stripeProduct.active) {
    throw new StripeProductConfigurationError(
      "stripe_product_inactive",
      `Das Stripe-Produkt oder der Stripe-Preis für "${product.name}" ist inaktiv.`
    );
  }
  if (normalizeCurrency(price.currency) !== normalizeCurrency(product.currency)) {
    throw new StripeProductConfigurationError(
      "stripe_currency_mismatch",
      `Die Stripe-Währung für "${product.name}" stimmt nicht mit der lokalen Währung überein.`
    );
  }
  if (positiveInt(price.unit_amount) !== positiveInt(product.priceAmount)) {
    throw new StripeProductConfigurationError(
      "stripe_amount_mismatch",
      `Der Stripe-Preis für "${product.name}" stimmt nicht mit dem lokalen Betrag überein.`
    );
  }
  const actualInterval = price.recurring?.interval ?? "";
  const actualIntervalCount = Number(price.recurring?.interval_count ?? (actualInterval ? 1 : 0));
  if (
    actualInterval !== product.recurringInterval ||
    (actualInterval && actualIntervalCount !== (product.recurringIntervalCount || 1))
  ) {
    throw new StripeProductConfigurationError(
      "stripe_recurring_mismatch",
      `Der Abrechnungszeitraum des Stripe-Preises für "${product.name}" ist ungültig.`
    );
  }

  return { price, stripeProduct };
}

export async function validateStripeProducts(
  stripe: InstanceType<typeof Stripe>,
  db: Firestore,
  config: StripeProductConfig,
  repair: boolean
): Promise<StripeValidationReport> {
  const localProducts = await loadCommerceProducts(db, config);
  const stripeProducts = await stripe.products.list({ limit: 100 }).autoPagingToArray({ limit: 10000 });
  const stripePrices = await stripe.prices.list({ limit: 100 }).autoPagingToArray({ limit: 10000 });
  const actions: StripeValidationAction[] = [];
  const productReports: StripeValidationProduct[] = [];

  for (const local of localProducts) {
    const issues: StripeValidationIssue[] = [];
    const hadLocalProductId = !!local.stripeProductId;
    const hadLocalPriceId = !!local.stripePriceId;
    let stripeProduct = selectStripeProduct(local, stripeProducts, stripePrices, issues);
    if (!stripeProduct && repair && !issues.some((issue) => issue.code === "duplicate_stripe_product")) {
      stripeProduct = await stripe.products.create({
        name: local.name,
        description: local.description || undefined,
        active: local.active,
        tax_code: local.taxCode || undefined,
        metadata: stripeMetadata(local)
      }, {
        idempotencyKey: `meduvalo-product-${stableId(local.localProductKey)}`
      });
      stripeProducts.push(stripeProduct);
      actions.push({
        action: "created-product",
        localProductKey: local.localProductKey,
        stripeProductId: stripeProduct.id,
        stripePriceId: "",
        message: `Stripe-Produkt "${stripeProduct.name}" wurde angelegt.`
      });
    }

    let stripePrice = stripeProduct
      ? selectStripePrice(local, stripeProduct, stripePrices, issues)
      : null;
    if (
      stripeProduct &&
      !stripePrice &&
      repair &&
      !issues.some((issue) => issue.code === "duplicate_stripe_price")
    ) {
      stripePrice = await stripe.prices.create({
        product: stripeProduct.id,
        currency: normalizeCurrency(local.currency),
        unit_amount: positiveInt(local.priceAmount),
        active: local.active,
        recurring: local.recurringInterval
          ? { interval: local.recurringInterval, interval_count: local.recurringIntervalCount || 1 }
          : undefined,
        lookup_key: lookupKey(local),
        metadata: stripeMetadata(local)
      }, {
        idempotencyKey: `meduvalo-price-${stableId([
          local.localProductKey,
          local.currency,
          local.priceAmount,
          local.recurringInterval,
          local.recurringIntervalCount
        ].join(":"))}`
      });
      stripePrices.push(stripePrice);
      actions.push({
        action: "created-price",
        localProductKey: local.localProductKey,
        stripeProductId: stripeProduct.id,
        stripePriceId: stripePrice.id,
        message: `Stripe-Preis für "${local.name}" wurde angelegt.`
      });
    }

    if (stripeProduct && stripePrice) {
      if (!stripeProduct.active) {
        addIssue(issues, "error", "stripe_product_inactive", local, "Das Stripe-Produkt ist inaktiv.");
      }
      if (!stripePrice.active) {
        addIssue(issues, "error", "stripe_price_inactive", local, "Der Stripe-Preis ist inaktiv.");
      }
      if (normalizeCurrency(stripePrice.currency) !== normalizeCurrency(local.currency)) {
        addIssue(issues, "error", "stripe_currency_mismatch", local, "Die Stripe-Währung stimmt nicht überein.");
      }
      if (positiveInt(stripePrice.unit_amount) !== positiveInt(local.priceAmount)) {
        addIssue(issues, "error", "stripe_amount_mismatch", local, "Der Stripe-Betrag stimmt nicht überein.");
      }
      if (
        (stripePrice.recurring?.interval ?? "") !== local.recurringInterval ||
        (local.recurringInterval &&
          Number(stripePrice.recurring?.interval_count ?? 1) !== (local.recurringIntervalCount || 1))
      ) {
        addIssue(issues, "error", "stripe_recurring_mismatch", local, "Der Abrechnungszeitraum stimmt nicht überein.");
      }
      if (
        repair &&
        !issues.some((issue) => issue.severity === "error") &&
        (local.stripeProductId !== stripeProduct.id || local.stripePriceId !== stripePrice.id)
      ) {
        await persistCommerceProductMapping(db, {
          ...local,
          stripeProductId: stripeProduct.id,
          stripePriceId: stripePrice.id
        });
        actions.push({
          action: local.stripeProductId || local.stripePriceId ? "saved-mapping" : "reused",
          localProductKey: local.localProductKey,
          stripeProductId: stripeProduct.id,
          stripePriceId: stripePrice.id,
          message: `Bestehende Stripe-Zuordnung für "${local.name}" wurde gespeichert.`
        });
      }
      local.stripeProductId = stripeProduct.id;
      local.stripePriceId = stripePrice.id;
    } else {
      if (!stripeProduct) {
        addIssue(issues, "error", "stripe_product_missing", local, "Passendes Stripe-Produkt fehlt.");
      } else if (!stripePrice) {
        addIssue(issues, "error", "stripe_price_missing", local, "Passender Stripe-Preis fehlt.");
      }
    }

    if (!local.stripeProductId || (!hadLocalProductId && !repair)) {
      addIssue(issues, "error", "local_stripe_product_id_missing", local, "Lokal fehlt stripeProductId.");
    }
    if (!local.stripePriceId || (!hadLocalPriceId && !repair)) {
      addIssue(issues, "error", "local_stripe_price_id_missing", local, "Lokal fehlt stripePriceId.");
    }
    if (!local.active) {
      addIssue(issues, "warning", "local_product_inactive", local, "Das lokale Produkt ist inaktiv.");
    }

    productReports.push({
      ...local,
      valid: !issues.some((issue) => issue.severity === "error"),
      issues
    });
  }

  const issues = productReports.flatMap((product) => product.issues);
  return {
    valid: !issues.some((issue) => issue.severity === "error"),
    repairRequested: repair,
    checkedAt: new Date().toISOString(),
    stripeMode: stripeProducts.some((product) => product.livemode) ? "live" : "test",
    products: productReports,
    issues,
    actions
  };
}

async function persistCommerceProductMapping(
  db: Firestore,
  product: CommerceProduct
): Promise<void> {
  const data = {
    localProductKey: product.localProductKey,
    productKind: product.productKind,
    catalogId: product.catalogId,
    name: product.name,
    description: product.description,
    stripeProductId: product.stripeProductId,
    stripePriceId: product.stripePriceId,
    currency: normalizeCurrency(product.currency).toUpperCase(),
    priceAmount: positiveInt(product.priceAmount),
    taxCode: product.taxCode,
    active: product.active,
    recurringInterval: product.recurringInterval,
    updatedAt: Timestamp.now()
  };
  await db.collection("commerceProducts").doc(stableId(product.localProductKey)).set(data, { merge: true });
  if (product.productKind === "catalog" && product.catalogCollection && product.catalogId) {
    await db.collection(product.catalogCollection).doc(product.catalogId).set({
      stripeProductId: product.stripeProductId,
      stripePriceId: product.stripePriceId,
      currency: normalizeCurrency(product.currency).toUpperCase(),
      priceAmount: positiveInt(product.priceAmount),
      taxCode: product.taxCode,
      active: product.active,
      stripeMappingUpdatedAt: Timestamp.now()
    }, { merge: true });
  }
}

function selectStripeProduct(
  local: CommerceProduct,
  products: any[],
  prices: any[],
  issues: StripeValidationIssue[]
): any | null {
  const stored = local.stripeProductId
    ? products.find((product) => product.id === local.stripeProductId)
    : undefined;
  if (local.stripeProductId && !stored) {
    addIssue(issues, "warning", "stored_stripe_product_missing", local, `Gespeichertes Stripe-Produkt ${local.stripeProductId} existiert nicht.`);
  }

  const metadataMatches = products.filter(
    (product) => product.metadata?.meduvaloProductKey === local.localProductKey
  );
  const aliases = productNameAliases(local).map(normalizeName);
  const nameMatches = products.filter((product) => aliases.includes(normalizeName(product.name)));
  const amountMatches = local.productKind === "base-product"
    ? products.filter((product) => prices.some((price) =>
      stripeProductId(price) === product.id && priceMatches(local, price)
    ))
    : [];
  const candidates = uniqueById([
    ...(stored ? [stored] : []),
    ...metadataMatches,
    ...nameMatches,
    ...amountMatches
  ]);
  if (candidates.length > 1) {
    addIssue(issues, "error", "duplicate_stripe_product", local, "Mehrere passende Stripe-Produkte wurden gefunden.");
    if (!stored) return null;
  }
  return stored ?? candidates[0] ?? null;
}

function selectStripePrice(
  local: CommerceProduct,
  product: any,
  prices: any[],
  issues: StripeValidationIssue[]
): any | null {
  const productPrices = prices.filter((price) => stripeProductId(price) === product.id);
  const stored = local.stripePriceId
    ? productPrices.find((price) => price.id === local.stripePriceId)
    : undefined;
  if (local.stripePriceId && !stored) {
    addIssue(issues, "warning", "stored_stripe_price_missing", local, `Gespeicherter Stripe-Preis ${local.stripePriceId} existiert nicht.`);
  }
  const exact = productPrices.filter((price) => priceMatches(local, price));
  const metadataMatches = productPrices.filter(
    (price) => price.metadata?.meduvaloProductKey === local.localProductKey && priceMatches(local, price)
  );
  const candidates = uniqueById([
    ...(stored && priceMatches(local, stored) ? [stored] : []),
    ...metadataMatches,
    ...exact
  ]);
  if (exact.length > 1) {
    addIssue(issues, "error", "duplicate_stripe_price", local, "Mehrere passende Stripe-Preise existieren.");
    if (!stored) return null;
  }
  return stored && priceMatches(local, stored) ? stored : candidates[0] ?? null;
}

function priceMatches(local: CommerceProduct, price: any): boolean {
  const interval = price.recurring?.interval ?? "";
  const intervalCount = Number(price.recurring?.interval_count ?? (interval ? 1 : 0));
  return price.active &&
    normalizeCurrency(price.currency) === normalizeCurrency(local.currency) &&
    positiveInt(price.unit_amount) === positiveInt(local.priceAmount) &&
    interval === local.recurringInterval &&
    (!interval || intervalCount === (local.recurringIntervalCount || 1));
}

function mergeMapping(
  product: CommerceProduct,
  mapping: Record<string, unknown> | undefined
): CommerceProduct {
  if (!mapping) return product;
  return {
    ...product,
    stripeProductId: stringValue(mapping.stripeProductId) || product.stripeProductId,
    stripePriceId: stringValue(mapping.stripePriceId) || product.stripePriceId,
    taxCode: stringValue(mapping.taxCode) || product.taxCode,
    active: typeof mapping.active === "boolean" ? mapping.active : product.active
  };
}

function catalogQuestionCount(data: Record<string, unknown>): number {
  const stored = positiveInt(data.questionCount);
  if (stored) return stored;
  try {
    const parsed = JSON.parse(stringValue(data.questionsJson));
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function productNameAliases(product: CommerceProduct): string[] {
  if (product.productKind === "base-product") {
    return [product.name, "Produktkauf", "Meduvalo Basiskauf", "Meduvalo Desktop"];
  }
  if (product.productKind === "subscription") {
    if (product.localProductKey === "subscription-semester") {
      return [product.name, "Meduvalo Semesterpass", "Meduvalo Semester"];
    }
    return [product.name, "Meduvalo Pro (Monat)", "Meduvalo Premium Monatsabo", "Meduvalo Vollzugang Monatsabo", "Meduvalo Monatsabo"];
  }
  return [product.name];
}

function stripeMetadata(product: CommerceProduct): Record<string, string> {
  return {
    meduvaloProductKey: product.localProductKey,
    meduvaloProductKind: product.productKind,
    ...(product.catalogId ? { meduvaloCatalogId: product.catalogId } : {})
  };
}

function lookupKey(product: CommerceProduct): string {
  return `meduvalo_${product.productKind.replaceAll("-", "_")}_${stableId(product.localProductKey).slice(0, 16)}`;
}

function stableId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase("de").replace(/\s+/g, " ");
}

function normalizeCurrency(value: unknown): string {
  return stringValue(value).toLowerCase() || "eur";
}

function positiveInt(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stripeProductId(price: any): string {
  return typeof price.product === "string" ? price.product : price.product.id;
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

function addIssue(
  issues: StripeValidationIssue[],
  severity: StripeValidationIssue["severity"],
  code: string,
  product: CommerceProduct,
  message: string
): void {
  if (issues.some((issue) => issue.code === code && issue.message === message)) return;
  issues.push({
    severity,
    code,
    localProductKey: product.localProductKey,
    message
  });
}
