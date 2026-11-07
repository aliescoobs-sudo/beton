# Fiche d'exercices — Bureau ventes

Données **fictives**. Compte à utiliser : « Bureau ventes » (e-mail ventes@formation.beton.invalid ; mot de passe : voir la fiche remise en main propre). Les mots de passe ne figurent dans aucune fiche : ils sont remis en main propre.

## À essayer
Ton menu (profil bureau ventes, sans montants) : *Ventes* → Nouveau devis, Chaîne des commandes, Nouvelle commande, À facturer, Facturer une commande, Saisir un paiement ; *Production* → Annulations, Où est mon camion, Chargements, Pompes. Tu n'as **pas** les écrans *Devis* ni *Commandes* (listes avec montants) : ils sont réservés au propriétaire et à l'administrateur.
1. **Nouveau devis** : *Ventes → Nouveau devis*, client Démo 3, B25, 12 m³. Résultat : le devis est enregistré ; tu n'en vois ni la liste ni le total (profil bureau). C'est le propriétaire ou l'administrateur qui le transforme en commande depuis *Devis*.
2. **Suivre les commandes du jour** : *Ventes → Chaîne des commandes* : une ligne par commande (commandé, planifié, chargé, livré, facturé), en quantités, jamais en montants. Retrouve les quatre commandes du jour (comptant, chèque à 30 jours, trois échéances, avance 50 %) et vois à quelle étape chacune en est.
3. **Nouvelle commande** : *Ventes → Nouvelle commande*, client Démo 3, B25, 12 m³, livraison demain. Résultat : un code CMD-… ; la commande attend le plan de la centrale (tu la retrouves dans *Chaîne des commandes*).
4. **Où est mon camion** : *Production → Où est mon camion* : les rotations du jour en lecture seule (camion, horaires, volume, client, étape atteinte). Ni prix ni montant.
5. **Annulation** : la commande de demain (client Démo 2, B20, 8 m³) n'est pas encore produite : dans *Production → Annulations*, ouvre le dossier d'annulation avec un motif. Tu ne **décides** pas : c'est le chef de centrale ou le propriétaire (colonne « À décider »). Une annulation ne supprime rien : elle crée une écriture.

Captures : `docs/training/screens/ventes-*.png` (jeu de données fictif).
