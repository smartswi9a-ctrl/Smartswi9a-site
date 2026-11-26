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
  deleteDoc,
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
      /* Demande de ramassage approuvee, prerequis a la creation produit. */
      await setDoc(doc(db, "vendor_pickup_requests", "pickupVendorA"), {
        vendorId: "vendorA",
        status: "approved",
        received_at_warehouse: true,
        items: [{ name: "New product", quantity: 10, receivedQuantity: 10, sku: "SWK-123456-01" }],
        desiredDate: "2026-12-01",
        createdAt: Timestamp.now()
      });
      /* Ramassage approuve mais PAS encore recu a l'entrepot :
         la creation de produit doit etre refusee. */
      await setDoc(doc(db, "vendor_pickup_requests", "pickupAwaitingReceipt"), {
        vendorId: "vendorA",
        status: "approved",
        received_at_warehouse: false,
        items: [{ name: "Awaiting", quantity: 5, receivedQuantity: 5, sku: "SWK-654321-01" }],
        desiredDate: "2026-12-03",
        createdAt: Timestamp.now()
      });
      await setDoc(doc(db, "vendor_pickup_requests", "pickupPendingVendorA"), {
        vendorId: "vendorA",
        status: "pending",
        items: [{ name: "Pending", quantity: 5 }],
        desiredDate: "2026-12-02",
        createdAt: Timestamp.now()
      });
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
      /* SUIVI PUBLICITAIRE (2026-11-26) : commandes de test pour le
         rattachement d'attribution (statut pending puis delivered). */
      await setDoc(doc(db, "orders", "attributionOrder"), {
        userId: "buyerA",
        status: "pending",
        total: 250,
        deliveryFee: 30,
        items: [{ productId: "publicProduct", quantity: 1 }],
        createdAt: Timestamp.now()
      });
      await setDoc(doc(db, "orders", "attributionDelivered"), {
        userId: "buyerA",
        status: "delivered",
        total: 250,
        deliveryFee: 30,
        items: [{ productId: "publicProduct", quantity: 1 }],
        createdAt: Timestamp.now()
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
      koulchiPrice: 90,
      warehouse_received: true,
      pickupRequestId: "pickupVendorA",
      sku: "SWK-123456-01",
      pickupItemIndex: 0
    }));

    /* VERROU ENTREPOT : ramassage approuve mais non recu -> refus. */
    await assertFails(setDoc(doc(vendorDb, "products", "notReceivedProduct"), {
      vendorId: "vendorA",
      status: "pending_admin_approval",
      nameFr: "Not received product",
      category: "smartphones-android",
      price: 100,
      koulchiPrice: 90,
      warehouse_received: true,
      pickupRequestId: "pickupAwaitingReceipt",
      sku: "SWK-654321-01",
      pickupItemIndex: 0
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
      koulchiPrice: 90,
      warehouse_received: true,
      pickupRequestId: "pickupVendorA",
      sku: "SWK-123456-02",
      pickupItemIndex: 1
    }));

    /* Une demande encore pending ne permet pas de creer un produit. */
    await assertFails(setDoc(doc(vendorDb, "products", "pendingPickupProduct"), {
      vendorId: "vendorA",
      status: "pending_admin_approval",
      nameFr: "Pending pickup",
      category: "smartphones-android",
      price: 100,
      koulchiPrice: 90,
      warehouse_received: true,
      pickupRequestId: "pickupPendingVendorA",
      sku: "SWK-123456-03",
      pickupItemIndex: 0
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

    /* --------------------------------------------- PANIERS ABANDONNÉS */

    function abandonedPayload(cartId, uid, overrides = {}) {
      return {
        cartId,
        uid,
        customerName: "Client Test",
        phone: "0612345678",
        city: "Casablanca",
        lang: "fr",
        items: [
          { id: "publicProduct", title: "Public", price: 100, qty: 1, image: "", isFlashSale: false }
        ],
        subtotalMad: 100,
        discountMad: 0,
        totalMad: 100,
        fcmToken: null,
        status: "active",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        remindedAt: null,
        recoveredOrderId: null,
        recoveredAt: null,
        ...overrides,
      };
    }

    const guestDb = env.unauthenticatedContext().firestore();

    /* Propriétaire connecté : docId == uid. */
    await assertSucceeds(setDoc(
      doc(buyerDb, "abandoned_carts", "buyerA"),
      abandonedPayload("buyerA", "buyerA")
    ));
    /* Un client ne peut pas écrire le panier d'un autre uid. */
    await assertFails(setDoc(
      doc(buyerDb, "abandoned_carts", "buyerB"),
      abandonedPayload("buyerB", "buyerB")
    ));
    /* Un client connecté ne peut pas usurper une session invitée. */
    await assertFails(setDoc(
      doc(buyerDb, "abandoned_carts", "guest-impostor"),
      abandonedPayload("guest-impostor", null)
    ));
    await assertSucceeds(getDoc(doc(buyerDb, "abandoned_carts", "buyerA")));

    /* Session invitée valide : cartId == docId, uid null, 06/07. */
    await assertSucceeds(setDoc(
      doc(guestDb, "abandoned_carts", "guest-1111"),
      abandonedPayload("guest-1111", null)
    ));
    /* Lecture interdite aux invités (aucune énumération possible). */
    await assertFails(getDoc(doc(guestDb, "abandoned_carts", "guest-1111")));

    /* Téléphone non marocain / statut inconnu / champ interdit : refusés. */
    await assertFails(setDoc(
      doc(guestDb, "abandoned_carts", "guest-2222"),
      abandonedPayload("guest-2222", null, { phone: "12345" })
    ));
    await assertFails(setDoc(
      doc(guestDb, "abandoned_carts", "guest-3333"),
      abandonedPayload("guest-3333", null, { status: "paid" })
    ));
    await assertFails(setDoc(
      doc(guestDb, "abandoned_carts", "guest-4444"),
      abandonedPayload("guest-4444", null, { adminNote: "injecté" })
    ));
    /* cartId différent du docId : refusé. */
    await assertFails(setDoc(
      doc(guestDb, "abandoned_carts", "guest-5555"),
      abandonedPayload("another-id", null)
    ));

    /* Cycle de relance : invité puis admin (WhatsApp / suppression). */
    await assertSucceeds(updateDoc(doc(guestDb, "abandoned_carts", "guest-1111"), {
      status: "reminded_whatsapp",
      remindedAt: serverTimestamp()
    }));
    await assertFails(updateDoc(doc(buyerDb, "abandoned_carts", "guest-1111"), {
      status: "recovered"
    }));
    await assertSucceeds(getDoc(doc(adminDb, "abandoned_carts", "guest-1111")));
    await assertSucceeds(updateDoc(doc(adminDb, "abandoned_carts", "guest-1111"), {
      status: "recovered",
      recoveredOrderId: "order-1",
      recoveredAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }));
    await assertFails(getDocs(query(collection(guestDb, "abandoned_carts"))));
    await assertSucceeds(getDocs(query(collection(adminDb, "abandoned_carts"))));
    await assertSucceeds(deleteDoc(doc(adminDb, "abandoned_carts", "guest-1111")));

    /* Un invité peut supprimer SON panier (session perdue / vidée). */
    await assertSucceeds(setDoc(
      doc(guestDb, "abandoned_carts", "guest-6666"),
      abandonedPayload("guest-6666", null)
    ));
    await assertSucceeds(deleteDoc(doc(guestDb, "abandoned_carts", "guest-6666")));
    // La collection de snapshots a été supprimée : aucun rôle client ou admin
    // ne doit conserver un accès à cette ancienne zone de sauvegarde.
    await assertFails(getDoc(doc(adminDb, "_test_snapshots", "batchA", "users", "buyerA")));
    await assertFails(getDoc(doc(buyerDb, "_test_snapshots", "batchA", "users", "buyerA")));

    await assertFails(updateDoc(doc(buyerDb, "users", "buyerA"), { role: "admin" }));

    /* PRESENCE : le proprietaire peut mettre a jour SA pastille uniquement. */
    await assertSucceeds(updateDoc(doc(buyerDb, "users", "buyerA"), {
      isOnline: true,
      lastSeenAt: Timestamp.now()
    }));
    /* Un compte ne peut pas falsifier la presence d un AUTRE compte. */
    await assertFails(updateDoc(doc(buyerDb, "users", "vendorA"), {
      isOnline: true,
      lastSeenAt: Timestamp.now()
    }));
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

    /* expireAt : champ TTL. Une date future proche (7 jours) est acceptee. */
    await assertSucceeds(setDoc(doc(anonDb, "presence", "visitor-ttl-2222"), {
      lastSeen: serverTimestamp(),
      sessionId: "session-ttl-2222",
      path: "/",
      expireAt: Timestamp.fromMillis(Date.now() + 7 * 24 * 60 * 60 * 1000)
    }, { merge: true }));

    /* Date passee : refusee (le document expirerait immediatement). */
    await assertFails(setDoc(doc(anonDb, "presence", "visitor-ttl-3333"), {
      lastSeen: serverTimestamp(),
      sessionId: "session-ttl-3333",
      path: "/",
      expireAt: Timestamp.fromMillis(Date.now() - 60 * 1000)
    }, { merge: true }));

    /* Date trop lointaine (30 jours, borne 8 jours) : refusee. */
    await assertFails(setDoc(doc(anonDb, "presence", "visitor-ttl-4444"), {
      lastSeen: serverTimestamp(),
      sessionId: "session-ttl-4444",
      path: "/",
      expireAt: Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000)
    }, { merge: true }));

    await assertFails(getDoc(doc(anonDb, "presence", "visitor-aaaa-1111")));
    await assertSucceeds(getDoc(doc(adminDb, "presence", "visitor-aaaa-1111")));

    /* Remise a zero du trafic : suppression reservee aux admins. */
    await assertFails(deleteDoc(doc(anonDb, "analytics_daily", todayKey)));
    await assertSucceeds(deleteDoc(doc(adminDb, "analytics_daily", todayKey)));
    await assertFails(deleteDoc(doc(anonDb, "presence", "visitor-aaaa-1111")));
    await assertSucceeds(deleteDoc(doc(adminDb, "presence", "visitor-aaaa-1111")));

    /* --------------------------------------------- SUIVI PUBLICITAIRE */
    const buyerBDb = env.authenticatedContext("buyerB").firestore();
    const validAttribution = {
      source: "tiktok",
      medium: "paid_social",
      campaign: "noel-2026",
      content: "video-a",
      clickIdType: "ttclid",
      landedAt: Timestamp.now()
    };

    /* Le propriétaire rattache l'attribution sur SA commande pending. */
    await assertSucceeds(updateDoc(doc(buyerDb, "orders", "attributionOrder"), {
      attribution: validAttribution
    }));
    /* Un autre client ne peut pas écrire sur cette commande. */
    await assertFails(updateDoc(doc(buyerBDb, "orders", "attributionOrder"), {
      attribution: validAttribution
    }));
    /* Un vendeur ne peut pas rattacher une attribution (chemin séparé). */
    await assertFails(updateDoc(doc(vendorDb, "orders", "attributionOrder"), {
      attribution: validAttribution
    }));
    /* Source inconnue, campagne trop longue, champ supplémentaire : refusés. */
    await assertFails(updateDoc(doc(buyerDb, "orders", "attributionOrder"), {
      attribution: { ...validAttribution, source: "spam" }
    }));
    await assertFails(updateDoc(doc(buyerDb, "orders", "attributionOrder"), {
      attribution: { ...validAttribution, campaign: "x".repeat(121) }
    }));
    await assertFails(updateDoc(doc(buyerDb, "orders", "attributionOrder"), {
      attribution: { ...validAttribution, extra: "x" }
    }));
    /* Aucun autre champ ne peut être modifié par ce chemin. */
    await assertFails(updateDoc(doc(buyerDb, "orders", "attributionOrder"), {
      status: "confirmed"
    }));
    /* Commande déjà livrée : l'attribution n'est plus modifiable. */
    await assertFails(updateDoc(doc(buyerDb, "orders", "attributionDelivered"), {
      attribution: validAttribution
    }));

    /* Compteurs agrégés anonymes : création + incrément. */
    await assertSucceeds(setDoc(doc(anonDb, "ad_events_daily", "2026-11-26_meta"), {
      date: "2026-11-26",
      source: "meta",
      viewContent: increment(1),
      updatedAt: serverTimestamp()
    }));
    await assertSucceeds(setDoc(doc(anonDb, "ad_events_daily", "2026-11-26_meta"), {
      date: "2026-11-26",
      source: "meta",
      addToCart: increment(1),
      updatedAt: serverTimestamp()
    }, { merge: true }));
    await assertSucceeds(setDoc(doc(anonDb, "ad_events_daily", "2026-11-26_tiktok"), {
      date: "2026-11-26",
      source: "tiktok",
      purchase: increment(1),
      revenueCreatedMad: increment(250.5),
      updatedAt: serverTimestamp()
    }));
    /* Identifiant incohérent / source inconnue / valeur négative : refusés. */
    await assertFails(setDoc(doc(anonDb, "ad_events_daily", "2026-11-26_spam"), {
      date: "2026-11-26",
      source: "spam",
      viewContent: increment(1),
      updatedAt: serverTimestamp()
    }));
    await assertFails(setDoc(doc(anonDb, "ad_events_daily", "2026-11-26_google"), {
      date: "2026-11-26",
      source: "google",
      viewContent: -1,
      updatedAt: serverTimestamp()
    }));
    /* Champ supplémentaire (donnée personnelle) : refusé. */
    await assertFails(setDoc(doc(anonDb, "ad_events_daily", "2026-11-26_google"), {
      date: "2026-11-26",
      source: "google",
      viewContent: increment(1),
      ip: "1.2.3.4",
      updatedAt: serverTimestamp()
    }, { merge: true }));
    /* Lecture réservée à l'admin. */
    await assertFails(getDoc(doc(anonDb, "ad_events_daily", "2026-11-26_meta")));
    await assertSucceeds(getDoc(doc(adminDb, "ad_events_daily", "2026-11-26_meta")));
    await assertFails(deleteDoc(doc(anonDb, "ad_events_daily", "2026-11-26_meta")));
    await assertSucceeds(deleteDoc(doc(adminDb, "ad_events_daily", "2026-11-26_meta")));

    /* Configuration pixels + budgets : admin uniquement. */
    const adsConfigPayload = {
      metaPixelId: "1234567890123456",
      tiktokPixelId: "CABC123456",
      spendMeta7: 500,
      spendTiktok7: 750,
      updatedAt: serverTimestamp()
    };
    await assertFails(setDoc(doc(buyerDb, "config", "ads"), adsConfigPayload));
    await assertSucceeds(setDoc(doc(adminDb, "config", "ads"), adsConfigPayload));
    await assertFails(getDoc(doc(anonDb, "config", "ads")));
    await assertSucceeds(getDoc(doc(adminDb, "config", "ads")));
    await assertFails(setDoc(doc(adminDb, "config", "ads"), {
      ...adsConfigPayload,
      metaPixelId: "PIXEL-ABC"
    }));
    await assertFails(setDoc(doc(adminDb, "config", "ads"), {
      ...adsConfigPayload,
      spendTiktok7: -5
    }));
    await assertFails(setDoc(doc(adminDb, "config", "ads"), {
      ...adsConfigPayload,
      secret: "x"
    }));

    /* Miroir public : lecture seule des IDs pixels. */
    await assertSucceeds(setDoc(doc(adminDb, "config", "ads_public"), {
      metaPixelId: "1234567890123456",
      tiktokPixelId: "CABC123456",
      updatedAt: serverTimestamp()
    }));
    await assertSucceeds(getDoc(doc(anonDb, "config", "ads_public")));
    await assertFails(setDoc(doc(buyerDb, "config", "ads_public"), {
      metaPixelId: "1234567890123456",
      tiktokPixelId: "CABC123456",
      updatedAt: serverTimestamp()
    }));
    await assertFails(setDoc(doc(adminDb, "config", "ads_public"), {
      metaPixelId: "1234567890123456",
      tiktokPixelId: "CABC123456",
      spendMeta7: 500,
      updatedAt: serverTimestamp()
    }));

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
