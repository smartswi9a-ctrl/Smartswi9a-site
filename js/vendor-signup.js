// js/vendor-signup.js
// ============================================================
// LOGIQUE D'INSCRIPTION VENDEUR
// Version 1.0.0
// ============================================================

import { registerVendorWithFirebase } from "./auth.js";
import { signVendorContract } from "./vendor-contract.js";
import { CONFIG } from "./config.js";
import { showToast } from "./ui-core.js";

let contractAccepted = false;
let contractDataHash = null; // Pour stocker l'IP et le hash après signature

document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('vendorSignupForm');
    const modal = document.getElementById('contractModal');
    const contractText = document.getElementById('contractText');
    const btnAcceptContract = document.getElementById('btnAcceptContract');
    const scrollHint = document.getElementById('scrollHint');
    const btnSubmitVendor = document.getElementById('btnSubmitVendor');
    const contractStatus = document.getElementById('contractStatus');

    // Gestion visuelle des cartes de livraison
    document.querySelectorAll('.v-choice').forEach(label => {
        label.addEventListener('click', () => {
            document.querySelectorAll('.v-choice').forEach(l => l.classList.remove('selected'));
            label.classList.add('selected');
            label.querySelector('input[type="radio"]').checked = true;
        });
    });

    // Ouvrir la modale
    document.getElementById('btnOpenContract').addEventListener('click', () => {
        modal.classList.add('open');
        document.body.style.overflow = 'hidden';
    });

    // Fermer la modale
    document.getElementById('btnCloseContract').addEventListener('click', () => {
        modal.classList.remove('open');
        document.body.style.overflow = '';
    });

    // Scroll obligatoire à 95% pour activer le bouton
    contractText.addEventListener('scroll', () => {
        const scrolled = contractText.scrollTop + contractText.clientHeight;
        const total = contractText.scrollHeight;
        
        if (scrolled >= total * 0.95) {
            btnAcceptContract.disabled = false;
            btnAcceptContract.style.opacity = '1';
            scrollHint.textContent = "✅ Vous pouvez maintenant signer.";
            scrollHint.style.color = "var(--success)";
        }
    });

    // Signature du contrat
    btnAcceptContract.addEventListener('click', async () => {
        btnAcceptContract.disabled = true;
        btnAcceptContract.textContent = "⏳ Capture de votre signature (IP)...";
        
        try {
            // On génère un faux ID temporaire pour la signature, 
            // le vrai ID sera lié juste après l'inscription Firebase.
            const mockUserId = 'temp_' + Date.now();
            const result = await signVendorContract(mockUserId, contractText.innerText);
            
            contractDataHash = result.hash; // On garde le hash pour l'inscription finale
            contractAccepted = true;
            
            // Mettre à jour l'UI
            modal.classList.remove('open');
            document.body.style.overflow = '';
            contractStatus.textContent = "✅ Contrat signé électroniquement le " + new Date().toLocaleDateString();
            contractStatus.style.color = "var(--success)";
            
            // Activer le bouton final
            btnSubmitVendor.disabled = false;
            btnSubmitVendor.style.opacity = '1';
            
            showToast('✅ Contrat signé avec succès !');
        } catch (e) {
            console.error(e);
            showToast('❌ Erreur lors de la signature du contrat.');
            btnAcceptContract.textContent = "✍️ J'accepte les conditions et je signe électroniquement";
            btnAcceptContract.disabled = false;
        }
    });

    // Soumission finale du formulaire
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        if (!contractAccepted) {
            showToast('⚠️ Vous devez signer le contrat avant de continuer.');
            return;
        }

        btnSubmitVendor.disabled = true;
        btnSubmitVendor.textContent = "⏳ Création du compte en cours...";

        const vendorData = {
            shopName: document.getElementById('vShopName').value.trim(),
            email: document.getElementById('vEmail').value.trim(),
            phone: document.getElementById('vPhone').value.trim(),
            city: document.getElementById('vCity').value.trim(),
            iceCin: document.getElementById('vIceCin').value.trim(),
            shippingMethod: document.querySelector('input[name="vShipping"]:checked').value
        };
        const password = document.getElementById('vPassword').value;

        try {
            // 1. Création du compte et du Wallet
            const authResult = await registerVendorWithFirebase(vendorData, password);
            
            // 2. Le compte est créé, on met à jour le contrat avec le VRAI UID
            if (authResult.uid && contractDataHash) {
                const { doc, setDoc } = await import("firebase/firestore");
                const { db } = await import("./firebase.js");
                
                await setDoc(doc(db, "contracts", `contract_${authResult.uid}`), {
                    vendorId: authResult.uid,
                    version: CONFIG.VENDOR.CONTRACT_VERSION,
                    acceptedAt: new Date(),
                    contractHash: contractDataHash,
                    status: 'accepted'
                });
            }

            showToast('🎉 Inscription réussie ! Vérifiez votre email.');
            
            // Redirection vers le dashboard vendeur (ou la page de connexion)
            setTimeout(() => {
                window.location.href = '/vendor/dashboard.html';
            }, 2000);

        } catch (error) {
            console.error("Erreur d'inscription:", error);
            showToast('❌ ' + (error.message || "Erreur lors de l'inscription"));
            btnSubmitVendor.disabled = false;
            btnSubmitVendor.textContent = "✅ Créer mon compte vendeur";
        }
    });
});