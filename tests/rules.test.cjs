const fs = require("node:fs");
const assert = require("node:assert/strict");
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails
} = require("@firebase/rules-unit-testing");
const {
  doc,
  setDoc,
  getDoc,
  updateDoc,
  arrayUnion,
  increment,
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
      await setDoc(doc(db, "users", "buyerA"), { role: "user", isAdmin: false, permissions: [] });
      await setDoc(doc(db, "users", "adminA"), { role: "admin", isAdmin: true, permissions: [] });
      await setDoc(doc(db, "users", "vendorA"), {
        role: "vendor",
        isAdmin: false,
        permissions: [],
        vendorInfo: { status: "approved", contractStatus: "accepted", contractVersion: "1.4.0", commissionRate: 0.07 }
      });
      await setDoc(doc(db, "users", "vendorB"), {
        role: "vendor",
        isAdmin: false,
        permissions: [],
        vendorInfo: { status: "approved", contractStatus: "accepted", contractVersion: "1.4.0" }
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
      await setDoc(doc(db, "vendor_orders", "vendorA", "orders", "multiOrder"), {
        vendorId: "vendorA",
        vendorCount: 2,
        status: "pending",
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
    await assertSucceeds(getDoc(doc(vendorDb, "vendor_orders", "vendorA", "orders", "multiOrder")));
    await assertFails(getDoc(doc(vendorBDb, "vendor_orders", "vendorA", "orders", "multiOrder")));

    await assertSucceeds(setDoc(doc(vendorDb, "products", "newProduct"), {
      vendorId: "vendorA",
      status: "pending_admin_approval",
      nameFr: "New product",
      price: 100
    }));
    await assertFails(setDoc(doc(oldVendorDb, "products", "oldContractProduct"), {
      vendorId: "vendorOld",
      status: "pending_admin_approval",
      nameFr: "Old contract product",
      price: 100
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
    await assertSucceeds(getDoc(doc(adminDb, "_test_snapshots", "batchA", "users", "buyerA")));
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

    console.log("PASS: Firestore and Storage authorization scenarios");
  } finally {
    await env.cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
