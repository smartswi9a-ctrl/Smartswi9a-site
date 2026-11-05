const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentWritten, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');

initializeApp();
const db = getFirestore();
const PROJECT_ID = 'smartswi9a-31063';
const FIREBASE_WEB_API_KEY = 'AIzaSyBhULwDxPBRqjywsSD_0ny41Bmt968ofSA';

const ALLOWED_ORIGINS = new Set([
    'https://smartswi9a.top', 
    'https://www.smartswi9a.top',
    'https://smartswi9a-31063.web.app',
    'https://smartswi9a-31063.firebaseapp.com'
]);

function cors(req, res) {
  const origin = req.get('origin');
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return true; }
  if (req.method !== 'POST') { res.status(405).json({success:false,message:'Méthode non autorisée.'}); return true; }
  if (origin && !ALLOWED_ORIGINS.has(origin)) { res.status(403).json({success:false,message:'Origine non autorisée.'}); return true; }
  return false;
}

function validPassword(p) { return typeof p === 'string' && p.length >= 8 && p.length <= 128 && /[A-Za-z]/.test(p) && /\d/.test(p); }
function validEmail(e) { return typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

async function findUserByEmail(email) {
  const snap = await db.collection('users').where('email', '==', email).limit(2).get();
  if (snap.empty) return null;
  if (snap.size > 1) throw new Error('Plusieurs profils utilisent cette adresse.');
  return { uid: snap.docs[0].id, data: snap.docs[0].data() };
}

function approved(profile) {
  return profile && profile.role === 'vendor' && profile.vendorInfo && profile.vendorInfo.status === 'approved' && profile.vendorInfo.contractStatus === 'accepted';
}

function statusMessage(profile) {
  const status = profile?.vendorInfo?.status;
  if (status === 'pending') return 'Votre demande vendeur est en attente de validation.';
  if (status === 'rejected') return 'Votre demande vendeur a été refusée.';
  if (status === 'suspended') return 'Votre accès vendeur est suspendu.';
  if (status === 'approved') return 'Votre contrat vendeur doit être accepté avant l’accès au tableau de bord.';
  return 'Ce compte ne dispose pas d’un accès vendeur approuvé.';
}

function getContractText(lang, version, snapshot) {
    const templates = {
        "1.1.0": {
            fr: (t) => `CONTRAT DE PARTENARIAT VENDEUR — SMART SWI9A\nVersion ${t.version}\n\nArticle 1 — Objet\nLe présent contrat encadre la mise en vente de produits par le Vendeur sur la plateforme Smart Swi9a (smartswi9a.top), marketplace marocaine d'appareils connectés et de produits pour la maison.\n\nArticle 2 — Inscription et vérification\nLe Vendeur s'engage à fournir des informations exactes (nom de boutique, téléphone, ville, ICE ou CIN). Toute fausse déclaration entraîne la suspension immédiate du compte.\n\nArticle 3 — Commission\nSmart Swi9a prélève une commission de ${(t.commissionRate*100).toFixed(0)} % sur le montant hors livraison de chaque vente. Cette commission peut être ajustée entre ${(t.commissionRateMin*100).toFixed(0)} % et ${(t.commissionRateMax*100).toFixed(0)} % avec l'accord écrit du Vendeur.\n\nArticle 4 — Expédition\nLe Vendeur choisit le dépôt en agence (drop-off) ou la logistique Smart Swi9a (fulfillment). Les délais de dépôt sont de ${t.dropoffDeadlineHoursNew} heures (nouveaux comptes) ou ${t.dropoffDeadlineHoursEstablished} heures (comptes matures). Tout retard peut entraîner une suspension.\n\nArticle 5 — Paiement\nLes gains sont crédités sur le portefeuille vendeur et deviennent disponibles ${t.unlockDaysVendor} jours après livraison confirmée (${t.unlockDaysSmart} jours pour les produits Smart Swi9a). Le retrait minimum est de ${t.minWithdrawal} MAD.\n\nArticle 6 — Retours\nEn cas de retour, des frais de ${t.returnFeeSpeedaf} MAD sont prélevés par colis retourné. Les retours répétés peuvent entraîner une révision du statut du Vendeur.\n\nArticle 7 — Résiliation\nChaque partie peut résilier ce contrat à tout moment. Les commandes en cours restent soumises aux présentes conditions.\n\nArticle 8 — Loi applicable\nLe présent contrat est régi par le droit marocain. Tout litige relève des tribunaux de Casablanca.\n\nArticle 9 — Signature électronique\nLa signature électronique vaut acceptation pleine et entière. L'IP, le user-agent, la date serveur et un hash SHA-256 du présent document sont enregistrés à titre de preuve.\n\nEn signant, le Vendeur reconnaît avoir lu et compris l'intégralité du présent contrat.`,
            ar: (t) => `عقد شراكة البائع — سمارت سويقة\nالإصدار ${t.version}\n\nالمادة 1 — الموضوع\nينظم هذا العقد عرض البائع لمنتجاته للبيع على منصة سمارت سويقة (smartswi9a.top)، وهي سوق مغربية للأجهزة المتصلة ومنتجات المنزل.\n\nالمادة 2 — التسجيل والتحقق\nيلتزم البائع بتقديم معلومات صحيحة (اسم المتجر، الهاتف، المدينة، ICE أو CIN). أي تصريح كاذب يؤدي إلى تعليق الحساب فوراً.\n\nالمادة 3 — العمولة\nتقتطع سمارت سويقة عمولة قدرها ${(t.commissionRate*100).toFixed(0)}% على مبلغ كل عملية بيع دون احتساب التوصيل. يمكن تعديل هذه العمولة بين ${(t.commissionRateMin*100).toFixed(0)}% و${(t.commissionRateMax*100).toFixed(0)}% بموافقة كتابية من البائع.\n\nالمادة 4 — الشحن\nيختار البائع الإيداع في الوكالة (drop-off) أو لوجستيك سمارت سويقة (fulfillment). مهل الإيداع هي ${t.dropoffDeadlineHoursNew} ساعة (الحسابات الجديدة) أو ${t.dropoffDeadlineHoursEstablished} ساعة (الحسابات الناضجة). أي تأخير قد يؤدي إلى تعليق الحساب.\n\nالمادة 5 — الدفع\nتُضاف الأرباح إلى محفظة البائع وتصبح متاحة بعد ${t.unlockDaysVendor} أيام من تأكيد التسليم (${t.unlockDaysSmart} يوماً لمنتجات سمارت سويقة). الحد الأدنى للسحب هو ${t.minWithdrawal} درهم.\n\nالمادة 6 — الإرجاع\nفي حالة الإرجاع، تُخصم رسوم قدرها ${t.returnFeeSpeedaf} درهماً لكل طرد مُرجع. الإرجاعات المتكررة قد تؤدي إلى مراجعة وضع البائع.\n\nالمادة 7 — الإنهاء\nيمكن لأي طرف إنهاء هذا العقد في أي وقت. تبقى الطلبات الجارية خاضعة لهذه الشروط.\n\nالمادة 8 — القانون المطبق\nيخضع هذا العقد للقانون المغربي. يختص القضاء في الدار البيضاء بأي نزاع.\n\nالمادة 9 — التوقيع الإلكتروني\nالتوقيع الإلكتروني يعتبر قبولاً تاماً وصريحاً. يتم تسجيل عنوان IP، ووكيل المستخدم، وتاريخ الخادم، وبصمة SHA-256 لهذا المستند كدليل.\n\nبالتوقيع، يقر البائع بأنه قرأ وفهم كامل هذا العقد.`,
            en: (t) => `VENDOR PARTNERSHIP AGREEMENT — SMART SWI9A\nVersion ${t.version}\n\nArticle 1 — Purpose\nThis agreement governs the listing and sale of products by the Vendor on Smart Swi9a (smartswi9a.top), a Moroccan marketplace for connected devices and home products.\n\nArticle 2 — Registration and verification\nThe Vendor agrees to provide accurate information (shop name, phone, city, ICE or CIN). Any false statement results in immediate account suspension.\n\nArticle 3 — Commission\nSmart Swi9a charges a ${(t.commissionRate*100).toFixed(0)}% commission on the delivery-excluded amount of each sale. This commission may be adjusted between ${(t.commissionRateMin*100).toFixed(0)}% and ${(t.commissionRateMax*100).toFixed(0)}% with the Vendor's written consent.\n\nArticle 4 — Shipping\nThe Vendor chooses agency drop-off or Smart Swi9a fulfillment. Drop-off deadlines are ${t.dropoffDeadlineHoursNew} hours (new accounts) or ${t.dropoffDeadlineHoursEstablished} hours (mature accounts). Any delay may result in suspension.\n\nArticle 5 — Payment\nEarnings are credited to the vendor wallet and become available ${t.unlockDaysVendor} days after confirmed delivery (${t.unlockDaysSmart} days for Smart Swi9a products). Minimum withdrawal is ${t.minWithdrawal} MAD.\n\nArticle 6 — Returns\nIn case of return, a ${t.returnFeeSpeedaf} MAD fee is charged per returned parcel. Repeated returns may lead to a review of the Vendor's status.\n\nArticle 7 — Termination\nEither party may terminate this agreement at any time. Pending orders remain subject to these terms.\n\nArticle 8 — Governing law\nThis agreement is governed by Moroccan law. Any dispute falls under the jurisdiction of the courts of Casablanca.\n\nArticle 9 — Electronic signature\nThe electronic signature constitutes full acceptance. The IP, user-agent, server date, and a SHA-256 hash of this document are recorded as evidence.\n\nBy signing, the Vendor acknowledges having read and understood this entire agreement.`
        },
        "1.2.0": {
            fr: (t) => `CONTRAT DE PARTENARIAT VENDEUR — SMART SWI9A\nVersion ${t.version}\n\nArticle 1 — Objet\nLe présent contrat encadre la mise en vente de produits par le Vendeur sur la plateforme Smart Swi9a (smartswi9a.top), marketplace marocaine d'appareils connectés et de produits pour la maison.\n\nArticle 2 — Inscription et vérification\nLe Vendeur s'engage à fournir des informations exactes (nom de boutique, téléphone, ville, ICE ou CIN). Toute fausse déclaration entraîne la suspension immédiate du compte.\n\nArticle 3 — Commission\nSmart Swi9a prélève une commission de ${(t.commissionRate*100).toFixed(0)} % sur le montant hors livraison de chaque vente. Cette commission peut être ajustée entre ${(t.commissionRateMin*100).toFixed(0)} % et ${(t.commissionRateMax*100).toFixed(0)} % avec l'accord écrit du Vendeur.\n\nArticle 4 — Expédition\nLe Vendeur choisit le dépôt en agence (drop-off) ou la logistique Smart Swi9a (fulfillment). Les délais de dépôt sont de ${t.dropoffDeadlineHoursNew} heures (nouveaux comptes) ou ${t.dropoffDeadlineHoursEstablished} heures (comptes matures). Tout retard peut entraîner une suspension.\n\nArticle 5 — Paiement\nLes gains sont crédités sur le portefeuille vendeur et deviennent disponibles ${t.unlockDaysVendor} jours après livraison confirmée (${t.unlockDaysSmart} jours pour les produits Smart Swi9a). Le retrait minimum est de ${t.minWithdrawal} MAD.\n\nArticle 6 — Retours\nEn cas de retour, des frais de ${t.returnFeeLivo} MAD sont prélevés par colis retourné (frais facturés par notre partenaire logistique Livo). Les retours répétés peuvent entraîner une révision du statut du Vendeur.\n\nArticle 7 — Résiliation\nChaque partie peut résilier ce contrat à tout moment. Les commandes en cours restent soumises aux présentes conditions.\n\nArticle 8 — Loi applicable\nLe présent contrat est régi par le droit marocain. Tout litige relève des tribunaux de Casablanca.\n\nArticle 9 — Signature électronique\nLa signature électronique vaut acceptation pleine et entière. L'IP, le user-agent, la date serveur et un hash SHA-256 du présent document sont enregistrés à titre de preuve.\n\nEn signant, le Vendeur reconnaît avoir lu et compris l'intégralité du présent contrat.`,
            ar: (t) => `عقد شراكة البائع — سمارت سويقة\nالإصدار ${t.version}\n\nالمادة 1 — الموضوع\nينظم هذا العقد عرض البائع لمنتجاته للبيع على منصة سمارت سويقة (smartswi9a.top)، وهي سوق مغربية للأجهزة المتصلة ومنتجات المنزل.\n\nالمادة 2 — التسجيل والتحقق\nيلتزم البائع بتقديم معلومات صحيحة (اسم المتجر، الهاتف، المدينة، ICE أو CIN). أي تصريح كاذب يؤدي إلى تعليق الحساب فوراً.\n\nالمادة 3 — العمولة\nتقتطع سمارت سويقة عمولة قدرها ${(t.commissionRate*100).toFixed(0)}% على مبلغ كل عملية بيع دون احتساب التوصيل. يمكن تعديل هذه العمولة بين ${(t.commissionRateMin*100).toFixed(0)}% و${(t.commissionRateMax*100).toFixed(0)}% بموافقة كتابية من البائع.\n\nالمادة 4 — الشحن\nيختار البائع الإيداع في الوكالة (drop-off) أو لوجستيك سمارت سويقة (fulfillment). مهل الإيداع هي ${t.dropoffDeadlineHoursNew} ساعة (الحسابات الجديدة) أو ${t.dropoffDeadlineHoursEstablished} ساعة (الحسابات الناضجة). أي تأخير قد يؤدي إلى تعليق الحساب.\n\nالمادة 5 — الدفع\nتُضاف الأرباح إلى محفظة البائع وتصبح متاحة بعد ${t.unlockDaysVendor} أيام من تأكيد التسليم (${t.unlockDaysSmart} يوماً لمنتجات سمارت سويقة). الحد الأدنى للسحب هو ${t.minWithdrawal} درهم.\n\nالمادة 6 — الإرجاع\nفي حالة الإرجاع، تُخصم رسوم قدرها ${t.returnFeeLivo} درهماً لكل طرد مُرجع (رسوم يفرضها شريكنا اللوجستي Livo). الإرجاعات المتكررة قد تؤدي إلى مراجعة وضع البائع.\n\nالمادة 7 — الإنهاء\nيمكن لأي طرف إنهاء هذا العقد في أي وقت. تبقى الطلبات الجارية خاضعة لهذه الشروط.\n\nالمادة 8 — القانون المطبق\nيخضع هذا العقد للقانون المغربي. يختص القضاء في الدار البيضاء بأي نزاع.\n\nالمادة 9 — التوقيع الإلكتروني\nالتوقيع الإلكتروني يعتبر قبولاً تاماً وصريحاً. يتم تسجيل عنوان IP، ووكيل المستخدم، وتاريخ الخادم، وبصمة SHA-256 لهذا المستند كدليل.\n\nبالتوقيع، يقر البائع بأنه قرأ وفهم كامل هذا العقد.`,
            en: (t) => `VENDOR PARTNERSHIP AGREEMENT — SMART SWI9A\nVersion ${t.version}\n\nArticle 1 — Purpose\nThis agreement governs the listing and sale of products by the Vendor on Smart Swi9a (smartswi9a.top), a Moroccan marketplace for connected devices and home products.\n\nArticle 2 — Registration and verification\nThe Vendor agrees to provide accurate information (shop name, phone, city, ICE or CIN). Any false statement results in immediate account suspension.\n\nArticle 3 — Commission\nSmart Swi9a charges a ${(t.commissionRate*100).toFixed(0)}% commission on the delivery-excluded amount of each sale. This commission may be adjusted between ${(t.commissionRateMin*100).toFixed(0)}% and ${(t.commissionRateMax*100).toFixed(0)}% with the Vendor's written consent.\n\nArticle 4 — Shipping\nThe Vendor chooses agency drop-off or Smart Swi9a fulfillment. Drop-off deadlines are ${t.dropoffDeadlineHoursNew} hours (new accounts) or ${t.dropoffDeadlineHoursEstablished} hours (mature accounts). Any delay may result in suspension.\n\nArticle 5 — Payment\nEarnings are credited to the vendor wallet and become available ${t.unlockDaysVendor} days after confirmed delivery (${t.unlockDaysSmart} days for Smart Swi9a products). Minimum withdrawal is ${t.minWithdrawal} MAD.\n\nArticle 6 — Returns\nIn case of return, a ${t.returnFeeLivo} MAD fee is charged per returned parcel (fee charged by our logistics partner Livo). Repeated returns may lead to a review of the Vendor's status.\n\nArticle 7 — Termination\nEither party may terminate this agreement at any time. Pending orders remain subject to these terms.\n\nArticle 8 — Governing law\nThis agreement is governed by Moroccan law. Any dispute falls under the jurisdiction of the courts of Casablanca.\n\nArticle 9 — Electronic signature\nThe electronic signature constitutes full acceptance. The IP, user-agent, server date, and a SHA-256 hash of this document are recorded as evidence.\n\nBy signing, the Vendor acknowledges having read and understood this entire agreement.`
        }
    };
    const t = templates[version] || templates["1.2.0"];
    return t[lang] ? t[lang](snapshot) : t["fr"](snapshot);
}

// 1. Synchronisation de vendorsPublic
exports.syncVendorPublic = onDocumentWritten('users/{userId}', async (event) => {
  const snap = event.data.after;
  if (!snap || !snap.exists) return;
  const data = snap.data();
  
  if (data.role !== 'vendor' || !data.vendorInfo) {
    return db.collection('vendorsPublic').doc(event.params.userId).delete().catch(() => {});
  }

  return db.collection('vendorsPublic').doc(event.params.userId).set({
    shopName: data.vendorInfo.shopName || 'Boutique',
    status: data.vendorInfo.status || 'pending',
    description: data.vendorInfo.description || '',
    createdAt: data.createdAt || FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
});

// 2. Signature sécurisée du contrat
exports.signVendorContract = onRequest({ region: 'europe-west1', cors: [...ALLOWED_ORIGINS] }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({success:false, message:'Connexion requise.'});
    const decoded = await getAuth().verifyIdToken(match[1], true);
    
    const { version, language, termsSnapshot, textHash } = req.body;
    if (!version || !language || !termsSnapshot || !textHash) return res.status(400).json({success:false, message:'Données incomplètes.'});

    const contractId = `contract_${decoded.uid}_v${version}`;
    const contractRef = db.collection('contracts').doc(contractId);
    
    const existing = await contractRef.get();
    if (existing.exists) {
      return res.status(200).json({success:true, alreadySigned: true, contractId});
    }

    const officialText = getContractText(language, version, termsSnapshot);
    const officialHash = crypto.createHash('sha256').update(officialText).digest('hex');

    if (officialHash !== textHash) {
      return res.status(400).json({success:false, message:'Falsification détectée : le hash ne correspond pas.'});
    }

    const contractHash = crypto.createHash('sha256').update([decoded.uid, version, language, textHash].join('|')).digest('hex');
    const ip = req.ip || req.get('x-forwarded-for') || 'unknown';

    await contractRef.set({
      vendorId: decoded.uid,
      version: version,
      language: language,
      termsSnapshot: termsSnapshot,
      textHash: textHash,
      contractHash: contractHash,
      acceptedAt: FieldValue.serverTimestamp(),
      ipAddress: ip,
      userAgent: req.get('user-agent') || 'unknown',
      status: 'accepted',
      source: req.body.source || 'dashboard'
    });

    await db.collection('users').doc(decoded.uid).update({
      'vendorInfo.contractStatus': 'accepted',
      'vendorInfo.currentContractId': contractId,
      'vendorInfo.contractVersion': version,
      'vendorInfo.contractSignedAt': FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    return res.status(200).json({success:true, contractId, version});
  } catch (error) {
    console.error('[signVendorContract]', error);
    return res.status(500).json({success:false, message:'Erreur serveur.'});
  }
});

// 3. Connexion Vendeur (autorise pending pour signature)
exports.loginVendor = onRequest({ region: 'europe-west1', maxInstances: 5, timeoutSeconds: 20 }, async (req, res) => {
  if (cors(req, res)) return;
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = req.body?.password;
  
  if (!validEmail(email) || typeof password !== 'string') {
    return res.status(400).json({success:false,message:'Identifiants invalides.'});
  }
  
  try {
    const userRecord = await findUserByEmail(email);
    if (!userRecord) return res.status(401).json({success:false,message:'Identifiants incorrects.'});
    
    const { uid, data: profile } = userRecord;
    const credentialSnap = await db.collection('vendorCredentials').doc(uid).get();
    let validCredential = false;
    
    if (credentialSnap.exists) {
      const credential = credentialSnap.data();
      if (credential.email === email && credential.passwordHash) {
        validCredential = await bcrypt.compare(password, credential.passwordHash);
      }
    }
    
    if (!validCredential) {
      const authResponse = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ email, password, returnSecureToken: true })
      });
      if (authResponse.ok) {
        const authData = await authResponse.json();
        validCredential = authData.localId === uid;
      }
    }
    
    if (!validCredential) return res.status(401).json({success:false,message:'Identifiants incorrects.'});
    
    const canLogin = approved(profile) || profile.vendorInfo?.status === 'pending';
    if (!canLogin) return res.status(403).json({success:false,message:statusMessage(profile)});
    
    const customToken = await getAuth().createCustomToken(uid, { vendorLogin: true });
    return res.status(200).json({success:true, customToken, needsContract: !approved(profile)});
  } catch (error) {
    console.error('[loginVendor]', error);
    return res.status(500).json({success:false,message:'Erreur temporaire.'});
  }
});

// 4. Définition du mot de passe vendeur
exports.setVendorPassword = onRequest({ region: 'europe-west1', maxInstances: 5, timeoutSeconds: 15 }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = req.get('authorization').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({success:false,message:'Connexion requise.'});
    const decoded = await getAuth().verifyIdToken(match[1], true);
    const vendorPassword = req.body?.vendorPassword;
    if (!validPassword(vendorPassword)) return res.status(400).json({success:false,message:'Mot de passe invalide.'});
    
    const ref = db.collection('users').doc(decoded.uid);
    const snap = await ref.get();
    if (!snap.exists || snap.data().role !== 'vendor') return res.status(403).json({success:false,message:'Profil invalide.'});
    
    const passwordHash = await bcrypt.hash(vendorPassword, 12);
    await db.collection('vendorCredentials').doc(decoded.uid).set({
      uid: decoded.uid,
      email: String(snap.data().email || '').trim().toLowerCase(),
      passwordHash,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    
    return res.status(200).json({success:true});
  } catch (error) {
    return res.status(500).json({success:false,message:'Erreur serveur.'});
  }
});

// 5. Actions Admin Vendeur
exports.adminVendorAction = onRequest({ region: 'europe-west1', cors: [...ALLOWED_ORIGINS] }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ success: false, message: 'Connexion requise.' });
    const decoded = await getAuth().verifyIdToken(match[1], true);
    const adminSnap = await db.collection('users').doc(decoded.uid).get();
    if (!adminSnap.exists || adminSnap.data()?.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Action réservée à un administrateur.' });
    }

    const vendorId = String(req.body?.vendorId || '').trim();
    const action = String(req.body?.action || '').trim();
    if (!vendorId || !['approved', 'rejected', 'suspended', 'deleted'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Action invalide.' });
    }

    const vendorRef = db.collection('users').doc(vendorId);
    const vendorSnap = await vendorRef.get();
    if (!vendorSnap.exists() || vendorSnap.data()?.role !== 'vendor') {
      return res.status(404).json({ success: false, message: 'Profil introuvable.' });
    }

    if (action === 'approved' && vendorSnap.data().vendorInfo?.contractStatus !== 'accepted') {
      return res.status(409).json({ success: false, message: 'Impossible d’approuver : contrat non signé.' });
    }

    if (action === 'deleted') {
      let deletedProducts = 0;
      let productsRemaining = false;
      for (let page = 0; page < 20; page++) {
        const productsSnap = await db.collection('products').where('vendorId', '==', vendorId).limit(400).get();
        if (productsSnap.empty) { productsRemaining = false; break; }
        const batch = db.batch();
        productsSnap.docs.forEach(docSnap => batch.delete(docSnap.ref));
        await batch.commit();
        deletedProducts += productsSnap.size;
        productsRemaining = productsSnap.size === 400;
        if (!productsRemaining) break;
      }
      
      await vendorRef.delete();
      await db.collection('vendorCredentials').doc(vendorId).delete().catch(() => {});
      try { await getAuth().deleteUser(vendorId); } catch (e) {}
      
      return res.status(200).json({ success: true, action, deletedProducts });
    }

    await vendorRef.update({
      'vendorInfo.status': action,
      'vendorInfo.statusUpdatedAt': FieldValue.serverTimestamp(),
      'vendorInfo.statusUpdatedBy': decoded.uid,
      updatedAt: FieldValue.serverTimestamp()
    });
    return res.status(200).json({ success: true, action });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 6. Retraits sécurisés
exports.requestWithdrawal = onRequest({ region: 'europe-west1', cors: [...ALLOWED_ORIGINS] }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({success:false, message:'Connexion requise.'});
    const decoded = await getAuth().verifyIdToken(match[1], true);
    
    const amount = Number(req.body?.amount);
    const method = String(req.body?.method || '');
    const account = String(req.body?.account || '');
    
    if (amount < 200) return res.status(400).json({success:false, message:'Minimum 200 MAD.'});
    
    const walletSnap = await db.collection('wallets').doc(decoded.uid).get();
    if (!walletSnap.exists) return res.status(404).json({success:false, message:'Wallet introuvable.'});
    
    const pendingReq = await db.collection('payout_requests').where('vendorId', '==', decoded.uid).where('status', '==', 'pending').get();
    if (!pendingReq.empty) return res.status(400).json({success:false, message:'Demande déjà en cours.'});
    
    const balance = Number(walletSnap.data().availableBalance) || 0;
    if (amount > balance) return res.status(400).json({success:false, message:'Solde insuffisant.'});
    
    await db.collection('payout_requests').add({
      vendorId: decoded.uid,
      vendorName: req.body.vendorName || 'Vendeur',
      amount, method, account,
      status: 'pending',
      requestedAt: FieldValue.serverTimestamp()
    });
    
    return res.status(200).json({success:true});
  } catch (error) {
    return res.status(500).json({success:false, message:error.message});
  }
});

// 7. Trigger Wallet sur changement de statut commande
exports.onOrderStatusChanged = onDocumentUpdated('orders/{orderId}', async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  
  if (before.status === after.status) return;

  if (after.status === 'delivered' && before.status !== 'delivered') {
    const vendorItems = {};
    after.items.forEach(item => {
      if (item.vendorId && item.vendorId !== 'smartswi9a') {
        if (!vendorItems[item.vendorId]) vendorItems[item.vendorId] = 0;
        vendorItems[item.vendorId] += (item.price * item.quantity);
      }
    });

    for (const [vendorId, subtotal] of Object.entries(vendorItems)) {
      const vendorSnap = await db.collection('users').doc(vendorId).get();
      if (!vendorSnap.exists) continue;
      
      const rate = vendorSnap.data().vendorInfo?.commissionRate || 0.07;
      const commission = Math.round(subtotal * rate * 100) / 100;
      const net = Math.round((subtotal - commission) * 100) / 100;
      
      if (net > 0) {
        const walletRef = db.collection('wallets').doc(vendorId);
        const walletSnap = await walletRef.get();
        const unlockDays = 7; 
        const unlockAt = new Date();
        unlockAt.setDate(unlockAt.getDate() + unlockDays);

        if (!walletSnap.exists) {
          await walletRef.set({ vendorId, pendingBalance: net, totalEarnings: net });
        } else {
          await walletRef.update({
            pendingBalance: FieldValue.increment(net),
            totalEarnings: FieldValue.increment(net)
          });
        }

        await db.collection('wallet_transactions').add({
          vendorId, type: 'sale', amount: net, orderId: event.params.orderId,
          status: 'pending', unlockAt: unlockAt, createdAt: FieldValue.serverTimestamp()
        });
      }
    }
  }
});

// 8. Checkout Client
exports.createCustomerOrder = onRequest({ region: 'europe-west1', maxInstances: 10, timeoutSeconds: 30, cors: [...ALLOWED_ORIGINS] }, async (req, res) => {
    if (cors(req, res)) return;
    try {
      const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
      if (!match) return res.status(401).json({success:false, message:'Connexion requise.'});
      const decoded = await getAuth().verifyIdToken(match[1], true);
      const input = req.body || {};
      const delivery = input.deliveryInfo || {};
      const rawItems = Array.isArray(input.items) ? input.items : [];
      if (!rawItems.length || rawItems.length > 50) return res.status(400).json({success:false,message:'Panier vide ou trop volumineux.'});
      for (const k of ['name','phone','address','city']) {
        if (typeof delivery[k] !== 'string' || !delivery[k].trim()) return res.status(400).json({success:false,message:`Champ obligatoire : ${k}`});
      }
      const merged = new Map();
      for (const it of rawItems) {
        const productId = String(it?.productId ?? '').trim();
        const qty = Math.floor(Number(it?.quantity));
        if (!productId || !Number.isFinite(qty) || qty < 1 || qty > 99) return res.status(400).json({success:false,message:'Article invalide.'});
        const v = it.variant && typeof it.variant === 'object' ? {size:String(it.variant.size || ''), color:String(it.variant.color || '')} : null;
        const key = JSON.stringify([productId, v?.size || '', v?.color || '']);
        const old = merged.get(key);
        if (old) old.quantity += qty; else merged.set(key, {productId, quantity:qty, variant:v, id:String(it.id || productId)});
      }
      const items = [...merged.values()];
      const orderRef = db.collection('orders').doc();
      const outcome = await db.runTransaction(async tx => {
        const productRefs = items.map(i => db.collection('products').doc(i.productId));
        const productSnaps = await Promise.all(productRefs.map(ref => tx.get(ref)));
        const vendorIdsSet = new Set();
        for (let i=0;i<productSnaps.length;i++) {
          if (!productSnaps[i].exists) throw new Error(`Produit introuvable.`);
          const pd=productSnaps[i].data();
          if (pd.status && pd.status !== 'approved') throw new Error(`Produit indisponible.`);
          const vid=String(pd.vendorId || 'smartswi9a'); if (vid !== 'smartswi9a') vendorIdsSet.add(vid);
        }
        let subtotal=0; const validatedItems=[]; const productUpdates=new Map();
        const workingProducts=new Map(productSnaps.map((snap,i)=>[items[i].productId,{...snap.data(),variants:Array.isArray(snap.data().variants)?snap.data().variants.map(v=>({...v})):undefined}]));
        for(let i=0;i<items.length;i++){
          const item=items[i], data=workingProducts.get(item.productId), qty=item.quantity;
          let stock=0, price=Number(data.price)||0; const update=productUpdates.get(item.productId)?.data || {salesCount:Number(data.salesCount)||0};
          update.salesCount=(Number(update.salesCount)||0)+qty; update.lastOrderId=orderRef.id; update.updatedAt=FieldValue.serverTimestamp();
          if(item.variant){
            const variants=Array.isArray(update.variants)?update.variants.map(v=>({...v})):(Array.isArray(data.variants)?data.variants.map(v=>({...v})):[]);
            const idx=variants.findIndex(v=>String(v.size||'')===item.variant.size && String(v.color||'')===item.variant.color);
            if(idx<0) throw new Error(`Variante indisponible.`);
            stock=Number(variants[idx].stock)||0; const vp=Number(variants[idx].price); if(Number.isFinite(vp)&&vp>0) price=vp;
            if(stock<qty) throw new Error(`Stock insuffisant.`);
            variants[idx].stock=stock-qty; update.variants=variants; update.stock=variants.reduce((sum,v)=>sum+(Number(v.stock)||0),0); data.variants=variants; data.stock=update.stock;
          } else { stock=Number(update.stock ?? data.stock)||0; if(stock<qty) throw new Error(`Stock insuffisant.`); update.stock=stock-qty; data.stock=update.stock; }
          data.salesCount=update.salesCount; productUpdates.set(item.productId,{ref:productRefs[i],data:update});
          subtotal += price*qty;
          validatedItems.push({id:item.id,productId:item.productId,vendorId:String(data.vendorId||'smartswi9a'),variant:item.variant,quantity:qty,price,name:String(data.nameFr||data.nameEn||'Produit')});
        }
        const deliveryFee = 30; 
        const discount = 0; 
        const total = Math.max(0, subtotal - discount + deliveryFee);
        const vendorList=[...new Set(validatedItems.map(i=>i.vendorId).filter(v=>v&&v!=='smartswi9a'))];
        const orderData={userId:decoded.uid,userName:String(delivery.name).trim(),items:validatedItems,vendorIds:vendorList,status:'pending',paymentStatus:'unpaid',subtotal,discount,deliveryFee,total,stockDeducted:true,deliveryAddress:delivery,createdAt:FieldValue.serverTimestamp()};
        productUpdates.forEach(u=>tx.update(u.ref,u.data)); tx.set(orderRef,orderData);
        return {orderId:orderRef.id,totals:{subtotal,discount,deliveryFee,total,vendorIds:vendorList},validatedItems};
      });
      return res.status(200).json({success:true,...outcome});
    } catch(error) { return res.status(400).json({success:false,message:error.message}); }
});

// 9. Annulation Client
exports.cancelCustomerOrder = onRequest({ region: 'europe-west1', maxInstances: 10, timeoutSeconds: 30, cors: [...ALLOWED_ORIGINS] }, async (req, res) => {
    if (cors(req, res)) return;
    try {
      const match=String(req.get('authorization')||'').match(/^Bearer\s+(.+)$/i);
      if(!match)return res.status(401).json({success:false,message:'Connexion requise.'});
      const decoded=await getAuth().verifyIdToken(match[1],true);
      const orderId=String(req.body?.orderId||'').trim();
      await db.runTransaction(async tx=>{
        const orderRef=db.collection('orders').doc(orderId), orderSnap=await tx.get(orderRef);
        if(!orderSnap.exists)throw new Error('Commande introuvable.');
        const order=orderSnap.data(); if(order.userId!==decoded.uid)throw new Error('Non autorisé.');
        if(!['pending','confirmed'].includes(order.status))throw new Error('Délai dépassé.');
        const items=Array.isArray(order.items)?order.items:[];
        const productIds=[...new Set(items.map(i=>String(i.productId)))];
        const refs=productIds.map(id=>db.collection('products').doc(id));
        const snaps=await Promise.all(refs.map(ref=>tx.get(ref)));
        if(order.stockDeducted===true){
          for(let i=0;i<productIds.length;i++){
            if(!snaps[i].exists)continue;
            const p=snaps[i].data(), productItems=items.filter(item=>String(item.productId)===productIds[i]);
            const upd={salesCount:Math.max(0,(Number(p.salesCount)||0)-productItems.reduce((sum,item)=>sum+Math.max(1,Math.floor(Number(item.quantity)||1)),0)),lastOrderId:orderId,updatedAt:FieldValue.serverTimestamp()};
            const variants=Array.isArray(p.variants)?p.variants.map(v=>({...v})):[];
            let simpleStock=Number(p.stock)||0;
            for(const item of productItems){
              const qty=Math.max(1,Math.floor(Number(item.quantity)||1));
              if(item.variant){const idx=variants.findIndex(v=>String(v.size||'')===String(item.variant.size||'')&&String(v.color||'')===String(item.variant.color||''));if(idx>=0)variants[idx].stock=(Number(variants[idx].stock)||0)+qty;}
              else simpleStock+=qty;
            }
            if(productItems.some(item=>item.variant)){upd.variants=variants;upd.stock=variants.reduce((sum,v)=>sum+(Number(v.stock)||0),0);}
            else upd.stock=simpleStock;
            tx.update(refs[i],upd);
          }
        }
        tx.update(orderRef,{status:'cancelled',cancelledAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp(),stockDeducted:false});
      });
      return res.status(200).json({success:true});
    } catch(error){return res.status(400).json({success:false,message:error.message});}
});

// 10. Déblocage des fonds échus (Appelé par l'admin)
exports.releaseDueFunds = onRequest({ region: 'europe-west1', cors: [...ALLOWED_ORIGINS], timeoutSeconds: 60 }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ success: false, message: 'Connexion requise.' });
    const decoded = await getAuth().verifyIdToken(match[1], true);
    
    const adminSnap = await db.collection('users').doc(decoded.uid).get();
    if (!adminSnap.exists || adminSnap.data()?.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Action réservée à un administrateur.' });
    }

    const batchSize = Math.min(Number(req.body?.batchSize) || 400, 1000);
    const now = new Date();
    
    let totalReleased = 0;
    let vendorsProcessed = 0;
    let transactionsReleased = 0;
    const errors = [];
    
    const txQuery = db.collection('wallet_transactions')
      .where('status', '==', 'pending')
      .where('unlockAt', '<=', now)
      .limit(batchSize);
      
    const txSnap = await txQuery.get();
    if (txSnap.empty) {
      return res.status(200).json({ success: true, totalReleased: 0, vendorsProcessed: 0, transactionsReleased: 0, errors: [] });
    }

    const byVendor = {};
    txSnap.forEach(doc => {
      const data = doc.data();
      if (!data.vendorId) return;
      if (!byVendor[data.vendorId]) byVendor[data.vendorId] = [];
      byVendor[data.vendorId].push({ id: doc.id, ref: doc.ref, data });
    });

    for (const [vendorId, txs] of Object.entries(byVendor)) {
      try {
        const walletRef = db.collection('wallets').doc(vendorId);
        
        const result = await db.runTransaction(async (t) => {
          const walletSnap = await t.get(walletRef);
          if (!walletSnap.exists) throw new Error('Wallet introuvable');
          
          let wallet = walletSnap.data();
          let pendingBalance = Number(wallet.pendingBalance) || 0;
          let availableBalance = Number(wallet.availableBalance) || 0;
          
          let vendorReleased = 0;
          let txsCount = 0;
          
          for (const tx of txs) {
            const amount = Number(tx.data.amount) || 0;
            const reversed = Number(tx.data.reversedAmount) || 0;
            const eligible = Math.max(0, amount - reversed);
            
            const releaseForThis = Math.min(eligible, pendingBalance);
            
            if (releaseForThis > 0) {
              pendingBalance -= releaseForThis;
              availableBalance += releaseForThis;
              vendorReleased += releaseForThis;
              txsCount++;
            }
            
            t.update(tx.ref, {
              status: 'released',
              releasedAt: FieldValue.serverTimestamp(),
              releasedAmount: releaseForThis
            });
          }
          
          if (vendorReleased > 0) {
            t.update(walletRef, {
              pendingBalance: Math.max(0, pendingBalance),
              availableBalance: availableBalance,
              lastUpdated: FieldValue.serverTimestamp()
            });
          }
          
          return { released: vendorReleased, count: txsCount };
        });
        
        totalReleased += result.released;
        transactionsReleased += result.count;
        vendorsProcessed++;
        
      } catch (err) {
        console.error(`Erreur release funds pour le vendeur ${vendorId}:`, err);
        errors.push({ vendorId, error: err.message });
      }
    }

    return res.status(200).json({
      success: true,
      totalReleased,
      vendorsProcessed,
      transactionsReleased,
      errors
    });

  } catch (error) {
    console.error('[releaseDueFunds]', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

// 11. Action Admin : Payer ou Rejeter un retrait
exports.adminPayoutAction = onRequest({ region: 'europe-west1', cors: [...ALLOWED_ORIGINS] }, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ success: false, message: 'Connexion requise.' });
    const decoded = await getAuth().verifyIdToken(match[1], true);
    
    const adminSnap = await db.collection('users').doc(decoded.uid).get();
    if (!adminSnap.exists || adminSnap.data()?.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Action réservée à un administrateur.' });
    }

    const payoutId = String(req.body?.payoutId || '');
    const action = String(req.body?.action || ''); // 'paid' ou 'rejected'

    if (!payoutId || !['paid', 'rejected'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Paramètres invalides.' });
    }

    await db.runTransaction(async (t) => {
      const payoutRef = db.collection('payout_requests').doc(payoutId);
      const payoutSnap = await t.get(payoutRef);
      if (!payoutSnap.exists) throw new Error('Demande introuvable');

      const payoutData = payoutSnap.data();
      if (payoutData.status !== 'pending') throw new Error('Cette demande a déjà été traitée.');

      if (action === 'paid') {
        const amount = Number(payoutData.amount) || 0;
        const vendorId = payoutData.vendorId;
        const walletRef = db.collection('wallets').doc(vendorId);
        const walletSnap = await t.get(walletRef);
        
        if (!walletSnap.exists) throw new Error('Wallet introuvable');
        const wallet = walletSnap.data();
        
        if (Number(wallet.availableBalance) < amount) {
          throw new Error(`Solde insuffisant : disponible ${wallet.availableBalance}, demandé ${amount}.`);
        }

        t.update(walletRef, {
          availableBalance: FieldValue.increment(-amount),
          totalWithdrawn: FieldValue.increment(amount),
          lastUpdated: FieldValue.serverTimestamp()
        });

        t.update(payoutRef, {
          status: 'paid',
          paidAt: FieldValue.serverTimestamp(),
          paidBy: decoded.uid
        });

        t.set(db.collection('wallet_transactions').doc(), {
          vendorId: vendorId,
          type: 'payout',
          amount: -amount,
          status: 'released',
          payoutRequestId: payoutId,
          description: 'Retrait payé (admin) - ' + (payoutData.method || 'Wafacash'),
          createdAt: FieldValue.serverTimestamp(),
          releasedAt: FieldValue.serverTimestamp()
        });

        await db.collection('notifications').add({
          userId: vendorId,
          type: 'payout_paid',
          title: 'Retrait payé',
          message: `Votre retrait de ${amount} MAD a été payé.`,
          read: false,
          createdAt: FieldValue.serverTimestamp(),
          payoutId: payoutId
        });
      } else {
        t.update(payoutRef, {
          status: 'rejected',
          rejectedAt: FieldValue.serverTimestamp(),
          rejectedBy: decoded.uid
        });

        await db.collection('notifications').add({
          userId: payoutData.vendorId,
          type: 'payout_rejected',
          title: 'Retrait rejeté',
          message: `Votre demande de retrait de ${payoutData.amount} MAD a été rejetée.`,
          read: false,
          createdAt: FieldValue.serverTimestamp(),
          payoutId: payoutId
        });
      }
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[adminPayoutAction]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});