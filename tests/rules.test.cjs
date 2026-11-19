const fs = require("node:fs");
const assert = require("node:assert/strict");
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails
} = require("@firebase/rules-unit-testing");
const {
  doc,
  collection,
  query,
  orderBy,
  where,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  arrayUnion,
  increment,
  serverTimestamp,
  Timestamp
} = require("firebase/firestore");
const { ref, uploadBytes } = require("firebase/storage");

async function main() {
  const env = await initializeTestEnvironment({
    projectId: "demo-smart-swi9a",
    firestore: { rules: fs.readFileSync("firestore.rules", "utf8") },
    storage: { rules: fs.readFileSync("storage.rules", "utf8") }
  });

  try {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      // Source unique de verite de la version de contrat (P0-2bis).
      // Les regles lisent config/app.contractVersion via get().
      await setDoc(doc(db, "config", "app"), { contractVersion: "1.5.0" });
      await setDoc(doc(db, "users", "buyerA"), { role: "user", isAdmin: false, permissions: [] });
      await setDoc(doc(db, "users", "adminA"), { role: "admin", isAdmin: true, permissions: [] });
      await setDoc(doc(db, "users", "vendorA"), {
        role: "vendor",
        isAdmin: false,
        permissions: [],
        vendorInfo: { status: "approved", contractStatus: "accepted", contractVersion: "1.5.0", commissionRate: 0.07 }
      });
      await setDoc(doc(db, "users", "vendorB"), {
        role: "vendor",
        isAdmin: false,
        permissions: [],
        vendorInfo: { status: "approved", contractStatus: "accepted", contractVersion: "1.5.0" }
      });
      await setDoc(doc(db, "users", "vendorOld"), {
        role: "vendor",
        isAdmin: false,
        permissions: [],
        vendorInfo: { status: "approved", contractStatus: "accepted", contractVersion: "1.3.0" }
      });
      await setDoc(doc(db, "products", "publicProduct"), { status: "approved", vendorId: "vendorA", nameFr: "Public" });
      await setDoc(doc(db, "products", "privateProduct"), { status: "pending_admin_approval", vendorId: "vendorA", nameFr: "Private" });
      await setDoc(doc(db, "orders", "multiOrder"), {
        userId: "buyerA",
        vendorIds: ["vendorA", "vendorB"],
        status: "pending",
        items: []
      });
      await setDoc(doc(db, "orders", "singleVendorOrder"), {
        userId: "buyerA",
        vendorIds: ["vendorA"],
        containsPlatformItems: false,
        status: "pending",
        items: [{ productId: "a", vendorId: "vendorA", quantity: 1 }]
      });
      await setDoc(doc(db, "orders", "legacyOrderWithoutPrivacyFlag"), {
        userId: "buyerA",
        vendorIds: ["vendorA"],
        status: "pending",
        items: [{ productId: "a", vendorId: "vendorA", quantity: 1 }]
      });
      await setDoc(doc(db, "orders", "mixedOrder"), {
        userId: "buyerA",
        vendorIds: ["vendorA"],
        containsPlatformItems: true,
        status: "pending",
        items: [
          { productId: "a", vendorId: "vendorA", quantity: 1 },
          { productId: "platform", vendorId: "smartswi9a", quantity: 1 }
        ]
      });
      await setDoc(doc(db, "vendor_orders", "vendorA", "orders", "multiOrder"), {
        vendorId: "vendorA",
        privacySafe: true,
        vendorCount: 2,
        status: "pending",
        createdAt: Timestamp.now(),
        items: [{ productId: "a", vendorId: "vendorA" }]
      });
      await setDoc(doc(db, "carts", "buyerA"), {
        userId: "buyerA",
        items: [],
        selectedCity: null,
        updatedAt: Timestamp.now()
      });
      await setDoc(doc(db, "_test_snapshots", "batchA"), { batchId: "batchA", status: "active" });
      await setDoc(doc(db, "_test_snapshots", "batchA", "users", "buyerA"), { role: "user" });
      await setDoc(doc(db, "reviews", "review_buyerA_1"), {
        userId: "buyerA",
        productId: 1,
        status: "approved",
        rating: 5,
        verifiedPurchase: true,
        likes: [],
        likesCount: 0,
        featured: false
      });
    });

    const buyerDb = env.authenticatedContext("buyerA").firestore();
    const vendorDb = env.authenticatedContext("vendorA").firestore();
    const vendorBDb = env.authenticatedContext("vendorB").firestore();
    const oldVendorDb = env.authenticatedContext("vendorOld").firestore();
    const adminDb = env.authenticatedContext("adminA").firestore();

    await assertSucceeds(getDoc(doc(buyerDb, "products", "publicProduct")));
    await assertFails(getDoc(doc(buyerDb, "products", "privateProduct")));
    await assertSucceeds(getDoc(doc(vendorDb, "products", "privateProduct")));

    await assertSucceeds(getDoc(doc(buyerDb, "orders", "multiOrder")));
    await assertFails(getDoc(doc(vendorDb, "orders", "multiOrder")));
    await assertFails(getDoc(doc(vendorDb, "orders", "singleVendorOrder")));
    await assertFails(getDoc(doc(vendorBDb, "orders", "singleVendorOrder")));
    await assertFails(getDoc(doc(vendorDb, "orders", "mixedOrder")));
    await assertFails(getDoc(doc(vendorDb, "orders", "legacyOrderWithoutPrivacyFlag")));
    await assertFails(updateDoc(doc(vendorDb, "orders", "mixedOrder"), {
      status: "confirmed",
      updatedAt: Timestamp.now()
    }));
    await assertSucceeds(updateDoc(doc(vendorDb, "orders", "singleVendorOrder"), {
      status: "confirmed",
      updatedAt: Timestamp.now()
    }));
    await assertFails(updateDoc(doc(vendorDb, "orders", "multiOrder"), {
      status: "confirmed",
      updatedAt: Timestamp.now()
    }));
    await assertSucceeds(getDoc(doc(vendorDb, "vendor_orders", "vendorA", "orders", "multiOrder")));
    await assertSucceeds(getDocs(query(
      collection(vendorDb, "vendor_orders", "vendorA", "orders"),
      where("privacySafe", "==", true),
      orderBy("createdAt", "desc")
    )));
    await assertFails(getDoc(doc(vendorBDb, "vendor_orders", "vendorA", "orders", "multiOrder")));

    await assertSucceeds(setDoc(doc(vendorDb, "products", "newProduct"), {
      vendorId: "vendorA",
      status: "pending_admin_approval",
      nameFr: "New product",
      category: "smartphones-android",
      price: 100,
      koulchiPrice: 90
    }));
    await assertFails(setDoc(doc(oldVendorDb, "products", "oldContractProduct"), {
      vendorId: "vendorOld",
      status: "pending_admin_approval",
      nameFr: "Old contract product",
      price: 100,
      koulchiPrice: 90
    }));
    /* K5 : le prix de groupe est obligatoire a la creation. */
    await assertFails(setDoc(doc(vendorDb, "products", "missingKoulchi"), {
      vendorId: "vendorA",
      status: "pending_admin_approval",
      nameFr: "Missing Koulchi",
      category: "smartphones-android",
      price: 100
    }));

    /* K5 : prix de groupe (koulchiPrice). */
    await assertSucceeds(setDoc(doc(vendorDb, "products", "koulchiProduct"), {
      vendorId: "vendorA",
      status: "pending_admin_approval",
      nameFr: "Koulchi product",
      category: "smartphones-android",
      price: 100,
      koulchiPrice: 90
    }));
    await assertFails(setDoc(doc(vendorDb, "products", "koulchiInvalid"), {
      vendorId: "vendorA",
      status: "pending_admin_approval",
      nameFr: "Koulchi invalid",
      category: "smartphones-android",
      price: 100,
      koulchiPrice: 120
    }));
    await assertSucceeds(updateDoc(doc(adminDb, "products", "koulchiProduct"), { status: "approved" }));
    await assertFails(updateDoc(doc(vendorDb, "products", "koulchiProduct"), { koulchiPrice: 80 }));
    await assertSucceeds(updateDoc(doc(vendorDb, "products", "koulchiProduct"), {
      koulchiPrice: 80,
      status: "pending_admin_approval"
    }));

    await assertSucceeds(getDoc(doc(buyerDb, "carts", "buyerA")));
    await assertFails(getDoc(doc(vendorDb, "carts", "buyerA")));
    await assertFails(setDoc(doc(buyerDb, "carts", "buyerB"), {
      userId: "buyerB", items: [], selectedCity: null, updatedAt: Timestamp.now()
    }));
    await assertSucceeds(updateDoc(doc(buyerDb, "carts", "buyerA"), {
      items: [{ productId: "publicProduct", quantity: 1 }],
      updatedAt: Timestamp.now()
    }));
    // La collection de snapshots a été supprimée : aucun rôle client ou admin
    // ne doit conserver un accès à cette ancienne zone de sauvegarde.
    await assertFails(getDoc(doc(adminDb, "_test_snapshots", "batchA", "users", "buyerA")));
    await assertFails(getDoc(doc(buyerDb, "_test_snapshots", "batchA", "users", "buyerA")));

    await assertFails(updateDoc(doc(buyerDb, "users", "buyerA"), { role: "admin" }));
    await assertFails(setDoc(doc(buyerDb, "reviews", "fakeVerified"), {
      userId: "buyerA",
      productId: 2,
      rating: 5,
      title: "Fake",
      comment: "Fake verified purchase",
      status: "pending",
      verifiedPurchase: true,
      likes: [],
      likesCount: 0,
      featured: false,
      photos: []
    }));

    await assertSucceeds(updateDoc(doc(buyerDb, "reviews", "review_buyerA_1"), {
      likes: arrayUnion("buyerA"),
      likesCount: increment(1)
    }));
    await assertFails(updateDoc(doc(buyerDb, "reviews", "review_buyerA_1"), {
      rating: 1
    }));

    const vendorStorage = env.authenticatedContext("vendorA").storage();
    const oldVendorStorage = env.authenticatedContext("vendorOld").storage();
    await assertSucceeds(uploadBytes(ref(vendorStorage, "vendors/vendorA/products/test.png"), new Uint8Array([1, 2, 3]), { contentType: "image/png" }));
    await assertFails(uploadBytes(ref(oldVendorStorage, "vendors/vendorOld/products/test.png"), new Uint8Array([1, 2, 3]), { contentType: "image/png" }));

    // Galerie secondaire : chemin reel produit par vendor-dashboard.js
    // (vendors/{uid}/products/gallery/{ts}_{nom}). Doit matcher {allPaths=**}.
    await assertSucceeds(uploadBytes(ref(vendorStorage, "vendors/vendorA/products/gallery/1700000000000_photo.png"), new Uint8Array([1, 2, 3]), { contentType: "image/png" }));
    await assertFails(uploadBytes(ref(oldVendorStorage, "vendors/vendorOld/products/gallery/1700000000000_photo.png"), new Uint8Array([1, 2, 3]), { contentType: "image/png" }));

    // Le wildcard elargi ne doit pas ouvrir la galerie a un autre vendeur :
    // vendorB (approved, contrat OK) ne peut pas ecrire dans le dossier de vendorA.
    const vendorBStorage = env.authenticatedContext("vendorB").storage();
    await assertFails(uploadBytes(ref(vendorBStorage, "vendors/vendorA/products/gallery/1700000000001_evil.png"), new Uint8Array([1, 2, 3]), { contentType: "image/png" }));

    // Type non-image refuse meme si le chemin est valide.
    await assertFails(uploadBytes(ref(vendorStorage, "vendors/vendorA/products/gallery/1700000000002_notimage.txt"), new Uint8Array([1, 2, 3]), { contentType: "text/plain" }));

    /* --------------------------------------------- MESURE D AUDIENCE */
    const anonDb = env.unauthenticatedContext().firestore();
    const todayKey = new Date().toISOString().slice(0, 10);

    await assertSucceeds(setDoc(doc(anonDb, "analytics_daily", todayKey), {
      views: increment(1),
      visitors: arrayUnion("visitor-aaaa-1111"),
      updatedAt: serverTimestamp()
    }, { merge: true }));

    await assertFails(setDoc(doc(anonDb, "analytics_daily", "pas-une-date"), {
      views: increment(1),
      visitors: arrayUnion("visitor-aaaa-1111"),
      updatedAt: serverTimestamp()
    }, { merge: true }));

    await assertFails(setDoc(doc(anonDb, "analytics_daily", todayKey), {
      views: increment(1),
      visitors: arrayUnion("visitor-aaaa-1111"),
      updatedAt: serverTimestamp(),
      ip: "1.2.3.4"
    }, { merge: true }));

    await assertFails(getDoc(doc(anonDb, "analytics_daily", todayKey)));
    await assertSucceeds(getDoc(doc(adminDb, "analytics_daily", todayKey)));

    /* Vue anonyme : compteur seul, sans identifiant (tous les visiteurs). */
    const anonymousDay = "2026-01-02";
    await assertSucceeds(setDoc(doc(anonDb, "analytics_daily", anonymousDay), {
      views: increment(1),
      updatedAt: serverTimestamp()
    }, { merge: true }));

    /* Vue consentie : identifiant seul, sans compteur. */
    await assertSucceeds(setDoc(doc(anonDb, "analytics_daily", anonymousDay), {
      visitors: arrayUnion("visitor-bbbb-2222"),
      updatedAt: serverTimestamp()
    }, { merge: true }));

    /* Meme ecriture anonyme avec un champ interdit : refusee. */
    await assertFails(setDoc(doc(anonDb, "analytics_daily", anonymousDay), {
      views: increment(1),
      updatedAt: serverTimestamp(),
      ip: "1.2.3.4"
    }, { merge: true }));

    await assertSucceeds(setDoc(doc(anonDb, "presence", "visitor-aaaa-1111"), {
      lastSeen: serverTimestamp(),
      sessionId: "session-aaaa-1111",
      path: "/koulchi"
    }, { merge: true }));

    await assertFails(setDoc(doc(anonDb, "presence", "visitor-aaaa-1111"), {
      lastSeen: serverTimestamp(),
      sessionId: "session-aaaa-1111",
      path: "/" + "x".repeat(200)
    }, { merge: true }));

    await assertFails(getDoc(doc(anonDb, "presence", "visitor-aaaa-1111")));
    await assertSucceeds(getDoc(doc(adminDb, "presence", "visitor-aaaa-1111")));

    /* --------------------------------------------- CODES PROMO */
    /* Lecture ciblee publique : le client verifie un code precis (getDoc). */
    await assertSucceeds(getDoc(doc(anonDb, "coupons", "PROMO10")));

    /* Enumeration de la collection : refusee aux anonymes, admin seulement.
       (Sinon n importe qui peut aspirer tous les codes promo.) */
    await assertFails(getDocs(query(collection(anonDb, "coupons"))));
    await assertSucceeds(getDocs(query(collection(adminDb, "coupons"))));

    console.log("PASS: Firestore and Storage authorization scenarios");
  } finally {
    await env.cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  // Emet l'assertion reelle comme annotation GitHub Actions :
  // le log complet du step exige les droits admin, l'annotation non.
  const raw = (error && (error.message || String(error))) || 'unknown';
  const esc = String(raw)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .slice(0, 900);
  console.log('::error title=rules.test.cjs failure::' + esc);
  process.exitCode = 1;
});
