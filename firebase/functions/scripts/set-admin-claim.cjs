const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

const email = process.argv[2];
if (!email) {
  console.error("Aufruf: node scripts/set-admin-claim.cjs admin@example.com");
  process.exit(1);
}

const projectId = readProjectId();
if (!projectId) {
  console.error("Firebase ProjectId fehlt. Lege firebase/.firebaserc an oder setze FIREBASE_PROJECT_ID.");
  process.exit(1);
}

admin.initializeApp({ projectId });

admin.auth()
  .getUserByEmail(email)
  .then((user) => admin.auth().setCustomUserClaims(user.uid, {
    ...(user.customClaims || {}),
    admin: true
  }))
  .then(() => {
    console.log(`Admin-Claim gesetzt für ${email}. Danach in MediTest ab- und wieder anmelden.`);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

function readProjectId() {
  const fromEnv = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  if (fromEnv) return fromEnv.trim();

  const files = [
    path.resolve(__dirname, "../../.firebaserc"),
    path.resolve(__dirname, "../../../.firebaserc"),
    path.resolve(__dirname, "../../../MediTest/appsettings.json")
  ];

  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    try {
      const json = JSON.parse(fs.readFileSync(file, "utf8"));
      const value = json?.projects?.default || json?.Auth?.Firebase?.ProjectId;
      if (typeof value === "string" && value.trim()) return value.trim();
    } catch {
      // Try next source.
    }
  }

  return "";
}
