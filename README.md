# Matrice — application autonome

Une matrice d'Eisenhower avec mode sombre, pomodoro et agenda Google,
hébergée sur GitHub Pages, avec connexion Google et tâches synchronisées
entre tous tes appareils via Firebase.

Aucune carte bancaire nécessaire : tout repose sur les plans gratuits
(Firebase Spark + GitHub Pages).

---

## Vue d'ensemble

| Besoin | Solution |
|---|---|
| Connexion / identité | Firebase Authentication (fournisseur Google) |
| Tâches synchronisées partout | Firestore (mise à jour en temps réel) |
| Agenda Google réel | Appel direct à l'API Google Calendar, avec le jeton obtenu à la connexion |
| Hébergement | GitHub Pages |

---

## Étape 1 — Créer le projet Firebase

1. Va sur **console.firebase.google.com** et clique sur **Ajouter un projet**.
2. Donne-lui un nom (ex. `ma-matrice`), continue les étapes par défaut.
3. Pas besoin d'activer Google Analytics si on te le propose — pas utile ici.

## Étape 2 — Activer la connexion Google

1. Dans le menu de gauche : **Build → Authentication**.
2. Onglet **Sign-in method** → clique sur **Google** → **Activer**.
3. Renseigne un email d'assistance (le tien suffit) → **Enregistrer**.

## Étape 3 — Créer la base Firestore

1. Menu de gauche : **Build → Firestore Database → Créer une base de données**.
2. Mode **Production**, choisis une région proche de toi.
3. Une fois créée, onglet **Règles** : remplace tout le contenu par celui
   du fichier `firestore.rules` fourni dans ce dossier, puis **Publier**.

## Étape 4 — Récupérer la configuration Web

1. Clique sur l'icône ⚙️ en haut à gauche → **Paramètres du projet**.
2. Section **Vos applications** → icône **`</>`** (Web) → donne un surnom
   à l'app → **Enregistrer l'application**.
3. Copie l'objet `firebaseConfig` affiché.
4. Ouvre `firebase-config.js` dans ce dossier et remplace les valeurs
   `"REMPLACE_MOI"` par les tiennes.

## Étape 5 — Activer l'agenda Google (Google Cloud Console)

Ton projet Firebase **est** un projet Google Cloud — pas besoin d'en créer un autre.

1. Va sur **console.cloud.google.com**, vérifie en haut que le bon projet
   est sélectionné (même nom que ton projet Firebase).
2. **APIs et services → Bibliothèque** → cherche **Google Calendar API** → **Activer**.
3. **APIs et services → Écran de consentement OAuth** :
   - Type d'utilisateur : **Externe**.
   - Renseigne un nom d'application + ton email (support et contact développeur).
   - Dans **Scopes (champs d'application)**, ajoute :
     `https://www.googleapis.com/auth/calendar.readonly`
   - Dans **Utilisateurs de test**, ajoute ta propre adresse Gmail (et celles
     de toute personne à qui tu veux donner accès — jusqu'à 100).
   - Pas besoin de validation Google : ce mode "test" suffit pour un usage personnel.

## Étape 6 — Publier sur GitHub

1. Crée un nouveau repository sur GitHub (public ou privé).
2. Dépose-y tous les fichiers de ce dossier (`index.html`, `style.css`,
   `app.js`, `firebase-config.js`).
   *(`firestore.rules` et ce `README.md` sont juste de la documentation,
   tu peux les inclure aussi.)*
3. **Settings → Pages** → Source : branche `main`, dossier `/ (root)` → **Save**.
4. GitHub te donne une URL du type `https://TON-PSEUDO.github.io/NOM-DU-REPO/`.

## Étape 7 — Autoriser cette adresse dans Firebase

1. Retour dans la Console Firebase → **Authentication → Settings**
   → onglet **Authorized domains**.
2. **Add domain** → colle juste le domaine, ex. `ton-pseudo.github.io`
   (sans `https://` ni le chemin du repo).

## Étape 8 — Tester

Ouvre ton URL GitHub Pages, clique sur **Se connecter avec Google**,
accepte l'accès à l'agenda → l'application doit s'afficher avec tes tâches
(vides au début) et un bouton **Synchroniser** fonctionnel.

---

## En cas de souci

- **"Erreur : origin not allowed" / "redirect_uri_mismatch" à la connexion** :
  va dans Google Cloud Console → **APIs et services → Identifiants** →
  ouvre le client OAuth créé automatiquement par Firebase (nommé un peu
  comme "Web client (auto created by Google Service)") → section
  **Origines JavaScript autorisées** → ajoute ton URL GitHub Pages complète
  (avec `https://`).
- **La popup Google se rouvre à chaque clic sur "Synchroniser"** : c'est
  normal après un rechargement de page — le jeton d'accès à l'agenda
  n'est valable qu'une heure et n'est pas mémorisé entre deux visites
  (contrairement à la connexion elle-même, qui reste active).
- **Les tâches n'apparaissent pas sur un autre appareil** : vérifie que tu
  es connecté avec le **même compte Google** sur les deux appareils.

---

## Fichiers

- `index.html` — structure de la page
- `style.css` — habillage visuel
- `app.js` — toute la logique (matrice, pomodoro, agenda, synchronisation)
- `firebase-config.js` — à compléter avec tes propres identifiants Firebase
- `firestore.rules` — règles de sécurité à coller dans la console Firebase
