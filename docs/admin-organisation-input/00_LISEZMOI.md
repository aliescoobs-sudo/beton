# Organisation de l'administration — Béton prêt à l'emploi (Tétouan)

Version 1 — 15/11/2026 — **PROJET à valider par la direction.** Document interne, ne pas diffuser hors de l'entreprise.

## Objet
Mettre en place une organisation claire du bureau : qui fait quoi, dans quel ordre, avec quels fichiers, et où chaque papier est rangé. Elle sert aujourd'hui avec Excel et le classement papier, et elle sera reprise telle quelle par l'application KAYAS (mêmes champs, mêmes numéros).

## Les 5 principes
1. **Un numéro, trois endroits.** Chaque pièce (BL, facture, chèque, bon d'achat) a UN numéro. Ce numéro est le même sur le papier, dans le nom du fichier scanné, et dans la ligne Excel (puis KAYAS).
2. **Une ligne = un événement.** Dans Excel, une ligne représente une livraison, un encaissement, un paiement, une dépense. Jamais de cellules fusionnées, jamais un mois par onglet.
3. **On ne supprime rien.** Une erreur se corrige par une ligne inverse avec le motif (voir `02_Organisation_du_travail/05_Procedures_cles.md`, P9).
4. **Pas de paiement sans pièce.** Toute sortie d'argent a une pièce justificative rattachée avant d'être validée.
5. **Quatre yeux.** Celui qui prépare n'est pas celui qui valide ; celui qui encaisse n'est pas celui qui rapproche la banque.

## Contenu du dossier
| Dossier | Contenu |
|---|---|
| `01_Organisation_et_postes` | Organigramme, fiches de poste (responsable administratif(ve) et commercial(e), assistante, direction, chef de centrale, chauffeurs, pompe, mécanicien, comptable externe) |
| `02_Organisation_du_travail` | Journée type, clôture quotidienne, routine hebdomadaire, clôture mensuelle, procédures clés, contrôle interne |
| `03_Archive_papier` | Plan de classement des classeurs, étiquettes à imprimer, conservation |
| `04_Dossier_numerique` | Règles de nommage + arborescence `KAYAS_ADMIN` prête à copier dans le Drive de l'entreprise |
| `05_Excel` | 7 classeurs modèles (vides, avec listes, validations, formules) + description de leur structure |
| `06_Lien_avec_KAYAS` | Correspondance entre chaque fichier Excel et les modules de l'application |

## Mise en service (ordre conseillé)
1. La direction relit et valide les fiches de poste et les seuils marqués `[X MAD]`.
2. Copier `04_Dossier_numerique/KAYAS_ADMIN` dans le Drive de l'entreprise ; donner les droits (voir `01_Arborescence_et_nommage.md`).
3. Copier les classeurs de `05_Excel` dans `KAYAS_ADMIN/10_Excel` (le fichier `PERSONNEL` dans `07_Personnel`, le tableau de bord réservé à la direction) ; remplir les onglets `Listes`.
4. Imprimer les étiquettes (`03_Archive_papier/02_Etiquettes_classeurs.md`) et préparer les classeurs et la pochette du jour.
5. Former les deux personnes du bureau (une demi-journée) puis démarrer à une date de bascule précise : les anciens mois ne sont pas ressaisis dans les nouveaux fichiers ; ils sont archivés tels quels dans `99_Archives`.

## Points à confirmer par la direction (valeurs provisoires dans les documents)
- Seuils de validation `[X MAD]` (paiements, remises, échéanciers).
- Taux de TVA et règles de facturation (à la livraison ou périodique) : à confirmer avec le comptable.
- Qui signe les chèques et les virements ; qui dépose en banque.
- Fréquence du comptage de caisse (proposé : hebdomadaire).
- Durées de conservation des documents (voir `03_Archive_papier/03_Regles_de_conservation.md`).
- Rattachement hiérarchique exact de l'assistante.
