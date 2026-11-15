# Étude du portail client Ciments du Maroc (mycimar.com) : leçons pour KAYAS

**Date :** 15 nov. 2026. **Méthode :** navigation par le lead dans le compte client de la société (accord d'Ali et du directeur), connexion faite par Ali. Rien n'a été commandé ni soumis : un article a été mis au panier pour voir le parcours de commande, puis retiré. Ce document ne contient **aucun chiffre réel**. Les chiffres sont dans le fichier d'audit privé, qui est séparé.

## 1. Ce qu'est le portail
C'est l'espace client d'un fournisseur de ciment (groupe Ciments du Maroc / Heidelberg Materials). L'en-tête montre le site qui sert le client (ici Asment Temara). Le compte est **un seul login par société cliente** (e-mail + mot de passe), sans utilisateurs multiples ni rôles.

## 2. Carte des écrans
| Menu | Contenu | Points notables |
|---|---|---|
| Tableau de bord | 3 cartes : livraisons non facturées, en cours, effets non échus. 2 cartes d'alerte rouges : impayés physiques, créances échues. Carte société. Courbe de consommation mensuelle (tonnes, un clic sur un point ouvre le détail). Dernières lignes de règlements, factures et livraisons. Compteurs devis / réclamations / demandes particulières. | Le résumé d'argent est visible en 5 secondes. Chaque bloc a « Voir plus » et un export Excel. |
| Demandes de devis | Ciments, Granulats | Formulaire, puis suivi « en cours / traités ». |
| Prise de commandes | Catalogue (panier) + Mes commandes | Catalogue filtrable (sac, vrac, palette). Le panier a 3 étapes : Panier → Livraison → Récapitulatif. L'étape Livraison demande : destination (liste des chantiers du client), mode (livré par l'usine / chargé à l'usine), **date et heure souhaitées**, **n° de commande du client (obligatoire)**, commentaire. L'heure est confirmée ensuite par le service client. La quantité par défaut est un camion (27 t). |
| Mes commandes | Liste filtrable : site, chantier, point d'expédition, statut, dates. Export Excel. | **Statuts : Créée → Confirmée → En traitement → Livrée → Terminée, ou Annulée.** Colonnes : n°, date, chantier, mode, plaque du camion, produit, quantité, statut, actions. |
| Produits | Fiches produits ciment, granulats (2 carrières), béton (5 usages) | Vitrine commerciale. |
| Mes livraisons | Liste filtrable par dates. Export Excel. | **Chaque BL porte : site expéditeur, n° BL, réceptionnaire (chantier), date et heure, incoterm, produit, tonnage, matricule du camion, n° de commande client, transporteur, et un suivi GPS en temps réel** (une fenêtre de carte). |
| Mes règlements | Site, référence (n° de chèque), type (chèque / virement), date, montant. Export Excel. | |
| Mes factures | Filtre par mois. Téléchargement du PDF de chaque facture. Export Excel. | Facturation **deux fois par mois** (le 15 et en fin de mois). |
| Mes consommations | Par période : site, mois, produit, tonnage facturé, montant HT. Export Excel. | C'est la vue la plus utile pour un contrôle des achats. |
| Documents | CGV et attestations de régularité fiscale à télécharger | |
| Réclamations | Formulaire : activité, n° de pièce, site, type (service / produit / logistique / autre), téléphone, contact, pièce jointe, commentaire. Suivi du statut. | Traçabilité des litiges. |
| Demandes particulières | Demandes d'information libres avec un statut | |
| Paramètres | Changement du mot de passe uniquement | **Pas de 2FA**, pas de journal des connexions, pas de sous-comptes. |

## 3. Ce qu'il fait bien (à reprendre dans KAYAS)
1. **Un tableau de bord d'argent en 5 secondes** : non facturé, en cours, effets non échus, plus des alertes rouges seulement quand il y a un problème. C'est exactement l'écran d'accueil du propriétaire que nous voulons (UX track, LEAD-HANDOFF §13).
2. **Le cycle de vie de la commande avec des statuts clairs**, y compris Annulée. Il est visible par le client et filtrable.
3. **Le n° de commande du client est obligatoire et repris sur chaque BL.** Cela rend possible le rapprochement commande → BL → facture → règlement. KAYAS doit l'appliquer dans les deux sens : nos bons de commande vers les fournisseurs, et le n° de commande / bon du client sur nos BL.
4. **Le BL complet** : heure, matricule, transporteur, chantier, tonnage exact, et un GPS. C'est le même esprit que notre PWA chauffeur (timestamps par étape).
5. **La facturation par quinzaine** et la vue « consommations » qui donne mois × produit × tonnage × HT.
6. **L'export Excel partout et le PDF de chaque facture** : le comptable peut travailler sans ressaisie.
7. **Un parcours de commande en 3 étapes** avec une date et une heure souhaitées, confirmées ensuite par le fournisseur. C'est proche de notre décision « Demande non ferme tant que le bureau n'a pas confirmé » (portail client, §4).
8. **Les réclamations structurées** (type, pièce jointe, statut).

## 4. Ses faiblesses (à éviter ou dépasser)
- **Sécurité** : e-mail + mot de passe, pas de 2FA, pas de journal, **un seul compte partagé** par toute la société cliente. Toute personne qui a eu le mot de passe (dont un employé parti) garde l'accès tant qu'il n'est pas changé. KAYAS garde TOTP, des comptes nominatifs et l'audit.
- Pas de rôles côté client : l'employé qui commande voit aussi les paiements.
- Le suivi GPS a renvoyé une erreur sur une livraison terminée.
- Pas de rapprochement explicite règlement → facture (on ne voit pas quel chèque solde quelle facture).
- Des références de chèque apparaissent plusieurs fois (voir l'audit). Il n'y a pas de contrôle visible d'unicité.
- Une navigation rapide a provoqué un « service unavailable » et la déconnexion (protection anti-robot ou instabilité).

## 5. Ce que KAYAS peut construire grâce à ce portail
**A. Côté achats (KAYAS client de ses fournisseurs)**
- **Rapprochement fournisseur automatique** : importer (Excel du portail, ou plus tard une API si le fournisseur en offre une) les livraisons, factures, règlements et consommations. Ensuite, rapprocher avec nos réceptions de ciment par centrale, nos chèques émis (talons) et le stock. Alertes : BL fournisseur sans réception chez nous, réception sans BL, livraison vers une destination qui n'est pas une centrale KAYAS, référence de chèque en double, écart de prix à la tonne, facture non payée à l'échéance.
- **Bon de commande fournisseur numéroté dans KAYAS** (le n° que l'on saisit sur le portail), lié ensuite au BL, à la réception, à la facture et au règlement.
- **Prix à la tonne par fournisseur, site et produit**, avec un historique et une alerte de hausse.

**B. Côté ventes (KAYAS fournisseur de ses clients)** : un modèle pour notre futur portail client (OFF jusqu'à la fin) : le même tableau de bord en 5 secondes, les statuts de commande, les BL avec horaires et camion, les factures PDF, le relevé, les réclamations. Avec en plus ce que le portail n'a pas : TOTP, des comptes nominatifs et des droits par client.

**C. Côté propriétaire** : l'accueil « 3 cartes + alertes rouges + courbe mensuelle » comme base du prototype de l'écran propriétaire.

## 6. Décisions à prendre (Ali / propriétaire)
1. Faut-il ajouter au périmètre un module « rapprochement fournisseurs » (import des Excel des portails fournisseurs) ? Proposé avant T12.
2. Liste officielle des destinations de livraison autorisées pour le ciment acheté (centrales KAYAS uniquement ?). Voir l'audit.
3. Sécurité du compte fournisseur : changer le mot de passe du portail maintenant (un employé du bureau est parti), le stocker dans le gestionnaire de mots de passe, et limiter qui le connaît.
