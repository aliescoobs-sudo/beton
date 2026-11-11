# Fiches d'exercices de la formation / بطاقات التمارين

Une fiche par rôle, en français et en arabe standard. Données fictives, aucun mot de passe.
Chaque matin, avant la séance : `./scripts/training-rearm.sh` (moins d'une minute ; garde les comptes et mots de passe, remet des livraisons du jour à faire). **À lancer AVANT que les stagiaires se connectent**, jamais pendant la séance : la remise à zéro annule toutes les commandes éligibles du jour à Tétouan (pas seulement celles qu'elle a créées) et n'est **pas tout-ou-rien** (plusieurs transactions : une exécution interrompue peut laisser une journée à moitié remise ; relancez-la).

**Local seulement, un profil de navigateur par identité (R15A).** La version de formation tourne sur un seul Mac, à `http://localhost:3000`, rien n'est public. Un profil de navigateur séparé par identité de formation ; ne jamais passer un téléphone d'une personne à l'autre en se déconnectant puis en se reconnectant dans la même page ; si quelque chose reste bloqué, arrêter l'exercice au lieu de continuer par-dessus.
**Menus vérifiés (2026-11-07)** contre la navigation réelle de chaque rôle (`src/app/shell/nav-model.ts`) : chaque fiche ne cite que des écrans que le rôle a vraiment.

| Rôle | FR | AR |
|---|---|---|
| Bureau ventes | [ventes.fr.md](ventes.fr.md) | [ventes.ar.md](ventes.ar.md) |
| Bureau achats | [achats.fr.md](achats.fr.md) | [achats.ar.md](achats.ar.md) |
| Chef de centrale Tétouan | [centrale-tetouan.fr.md](centrale-tetouan.fr.md) | [centrale-tetouan.ar.md](centrale-tetouan.ar.md) |
| Chef de centrale Chefchaouen | [centrale-chefchaouen.fr.md](centrale-chefchaouen.fr.md) | [centrale-chefchaouen.ar.md](centrale-chefchaouen.ar.md) |
| Chauffeur (CH-01, CH-02, CH-03) | [chauffeur.fr.md](chauffeur.fr.md) | [chauffeur.ar.md](chauffeur.ar.md) |
| Pompiste | [pompiste.fr.md](pompiste.fr.md) | [pompiste.ar.md](pompiste.ar.md) |
| Comptable | [comptable.fr.md](comptable.fr.md) | [comptable.ar.md](comptable.ar.md) |
| Propriétaire | [proprietaire.fr.md](proprietaire.fr.md) | [proprietaire.ar.md](proprietaire.ar.md) |
| Administrateur | [admin.fr.md](admin.fr.md) | [admin.ar.md](admin.ar.md) |

**Historique importé (jumeau fictif)** : la répétition rôle par rôle de l'import de l'historique (livraisons et dépenses) est dans [HISTORIQUE-REPETITION.fr.md](HISTORIQUE-REPETITION.fr.md).

Les captures (téléphone, ×2) sont produites par `corepack pnpm training:screens` à partir d'une base de formation fictive.
