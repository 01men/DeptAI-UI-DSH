> **French edition (Tier-2 overview)** — machine-assisted translation, unified by the i18n PM. **The Chinese original governs.**
> Source baseline: 2026-10-15 · Glossary: [../GLOSSARY.md](../GLOSSARY.md) · Governance: [../README.md](../README.md)

# YuanBingKe (ybkk-AIOS) — gestion des ressources d'IA d'entreprise

**Positionnement :** une plateforme de gestion des ressources d'IA pour l'entreprise, bâtie sur
l'architecture dsh « Everything is a plugin » (tout est plugin).

YuanBingKe (nom de marque chinois d'origine : 元冰可, code produit ybkk-AIOS) est une plateforme
d'entreprise auto-hébergée (self-hosted) de gestion centralisée des ressources d'IA. Elle repose sur
l'architecture de dsh (DeepSeek Harness). Six types d'actifs y sont gérés sous une identité unique
(IAM/OIDC SSO), un jeu de permissions unique, une mesure d'utilisation unique et un audit unique.

## Le constat et la réponse

Dans beaucoup d'organisations, l'IA se développe en archipel : services MCP, skills, agents et
applications d'IA sont exploités en silos — comptes dispersés, droits flous, coûts de modèles opaques
et aucune piste d'audit exploitable. La direction informatique comme la conformité ne savent ni qui
utilise quelle ressource d'IA, ni ce qu'elle coûte réellement, ni quels risques elle fait courir.

YuanBingKe répond par un plan de contrôle unifié : une identité, un modèle de permissions, une mesure
d'utilisation transparente et une piste d'audit continue pour l'ensemble des actifs d'IA. Toute
modification suit des étapes définies de validation et d'approbation (brouillon → vérification →
canari → déploiement général), et chaque action laisse une trace vérifiable. Auto-hébergée, la
plateforme reste dans le périmètre informatique de l'entreprise.

## Six types d'actifs, un socle commun

- **Services MCP** — déploiement versionné avec canari (canary), versions immuables et passerelle de jetons à la granularité de l'outil.
- **Skills** — capacités validées du marché de skills, publiées par version après analyse statique et validation à deux niveaux.
- **Agents** — agents enregistrés avec identifiants machine, rôle organisationnel et niveaux d'autonomie définis.
- **Applications d'IA** — applications internes et externes avec SSO, métriques (PV/UV/DAU) et visibilité des coûts.
- **Routes de modèles** — accès aux modèles via la passerelle dédiée, avec gouvernance des canaux.
- **Stockage NAS** — partage de fichiers géré comme classe d'actifs, avec permissions de données et liens de téléchargement signés.

## Capacités clés

- **IAM unifié** : arborescence organisationnelle multi-niveaux, rôles et groupes d'utilisateurs,
  matrice de permissions ; fournisseur OIDC (RS256/JWKS/PKCE) comme SSO pour les applications d'IA
  raccordées, avec porte de mise en ligne (go-live gate).
- **Déploiement MCP maîtrisé** : parcours draft → validate → canary → full rollout, versions
  immuables, retour arrière en un clic, passerelle de jetons avec groupes de droits, granularité par
  outil et contrainte lecture seule, disjonction automatique (circuit breaking) et supervision P95.
- **Marché de skills sous contrôle** : soumission → analyse statique (rejet automatique du code
  malveillant et des fuites de secrets) → validation à deux niveaux → publication versionnée ;
  vérification des contrats par signature Ed25519.
- **Agents à autonomie encadrée** : identifiants machine, chaîne de jetons on-behalf-of, topologie
  d'orchestration lisible en un coup d'œil ; niveaux d'autonomie A0–A3 et invocations nommées A2A
  entre agents.
- **Orchestration de workflows (flow-core)** : orchestration TF à machine à états par étape,
  bibliothèque de modèles et contextPack, suivi SLA et avancement, chronologie Gantt.
- **Passerelle d'accès aux modèles (modelgw)** : relais réel compatible OpenAI (jamais de réponse
  fabriquée), gouvernance des canaux avec routage par niveaux, chaînes de repli (fallback) et
  coupe-circuit budgétaire (budget circuit breaker).
- **Mesure transparente de l'utilisation + rapport FinOps** : pipeline de mesure idempotent,
  instantané à prix zéro, répercussion interne des coûts par département × modèle (cost
  pass-through), coût par DAU, export CSV en un clic (UTF-8 BOM, compatible Excel).
- **Hub d'exécution et travailleurs numériques (domaine workforce)** : arbres d'objectifs avec
  alignement des buts, boucle de battement de cœur de 30 s, verrous d'exécution (CAS), planification
  de routines par intervalle/cron/webhook, autorisations de travail temporaires (permits) et boucle
  livraison → acceptation humaine avec déverrouillage soumis à approbation L4.
- **NAS avec permissions de données** : raccordement via une passerelle de fichiers MCP (jamais
  d'accès direct aux API privées DSM), RBAC fondé sur l'emplacement organisationnel et la hiérarchie
  des rôles en deny par défaut, URL de téléchargement signées, suivi de la propriété des fichiers.
- **Plateforme en tant que serveur MCP** : `POST /mcp` expose plus de 40 outils d'exploitation à tout
  client MCP (ZCode, Claude, Cursor, etc.), avec jeton Bearer et points de permission par outil.

## Modèle commercial

YuanBingKe est proposé selon le modèle **« équipe + actifs métier »** : la tarification dépend du nombre
d'équipes activées et des packs d'actifs métier retenus (packs sectoriels, packs de scénarios), et
non d'une licence plateforme forfaitaire. Pour l'industrie manufacturière, une **livraison privée
on-premises au format projet** est disponible.

La plateforme n'embarque délibérément aucune sémantique de facturation ni de règlement : le livre des
prix fonctionne en instantané à prix zéro (champ `charge` toujours 0) et restitue la transparence
d'utilisation ainsi que la répercussion interne des coûts (cost pass-through). Portefeuille,
recharges et refacturation ont été retirés du produit.

## Déploiement et exploitation

- **Auto-hébergé, socle léger** : Node ≥ 22.6, TypeScript natif sans étape de build ; point d'accès
  par défaut `http://127.0.0.1:7300`.
- **Deux modes d'installation** : bundle dsh (`dsh plugin --profile web add github:01men/ybkkasi`,
  25 entrées de plugins, plan de données sous le préfixe `/rq`) ou processus autonome avec
  `npm install && npm start`.
- **Mode démo pour l'évaluation** : `DEMO_SEED=1 npm start` injecte un jeu de données de
  démonstration. Réservé aux environnements de démonstration — à laisser désactivé en production.
- **Mise à jour autonome de la plateforme** : vérification automatique des versions (par défaut
  toutes les 24 h, désactivable via `DSH_UPDATE_AUTO_CHECK=off`), mise à niveau depuis la
  console（控制台）avec essai à blanc (dry-run) et audit ; miroirs privés via `DSH_UPDATE_API_BASE` /
  `DSH_UPDATE_RAW_BASE`. Points de permission : `platform.update.read`, `platform.update.apply`.
- **Exploitation et traçabilité** : CLI `node cli/dshctl.mjs`, événements d'utilisation conservés
  730 jours par défaut (`USAGE_RETENTION_DAYS`), quatre classes de journaux d'audit, export CSV des
  rapports d'utilisation et FinOps.
- **Porte de qualité** : `npm run selftest` exécute des tests de bout en bout sur une instance isolée
  (plus de 1 380 vérifications, selon la dernière exécution).

## Pourquoi c'est pertinent pour la France et l'Afrique francophone

- **Souveraineté des données** : l'auto-hébergement et la livraison privée on-premises constituent
  la voie de résidence des données — la plateforme tourne sur l'infrastructure de l'entreprise, en
  France ou sur site local, sans dépendance cloud imposée ; un processus DPA figure sur la feuille
  de route.
- **Couverture France + Afrique francophone** : le format projet on-premises et l'exploitation en
  environnement à bande passante réduite (documentation Markdown pur, miroirs privés pour la mise à
  jour) conviennent aux contextes d'Afrique de l'Ouest, d'Afrique centrale et du Maghreb comme aux
  sièges en France.
- **Gouvernance vérifiable** : validations à deux niveaux, ancres de preuve d'audit, approbations
  obligatoires L4 et autorisation par scénario en fail-closed soutiennent les contrôles internes et
  les revues de conformité.

> Avertissement de sincérité : ces points décrivent des capacités techniques et des options de
> livraison, non des certifications — SOC 2 / ISO 27001 ne sont pas obtenus et figurent sur la
> feuille de route. Avant toute entrée de marché, une revue de conformité par un conseil local est
> nécessaire ; le présent document ne constitue pas un avis juridique.

## Note sur la langue de l'interface

Depuis la version du 2026-10-16, l'interface d'exécution (console（控制台）, panneaux, portail, sorties
CLI, notifications, messages d'erreur) intègre un sélecteur de langue : chinois simplifié (par défaut),
anglais (US) et japonais. Le basculement se fait via le sélecteur en haut de l'écran ; la préférence
est enregistrée dans le navigateur (`rq_lang`). La CLI suit `--lang` ou `DSHCTL_LANG`. Toute chaîne
non encore couverte par un dictionnaire retombe élégamment sur le chinois. Les noms chinois d'origine
entre parenthèses, qui accompagnent les termes français dans ces documents, restent utiles — par
exemple pour les captures d'écran, les déploiements on-prem figés en chinois et les libellés proches
du protocole ; la traduction du navigateur reste également disponible.

## Pour aller plus loin

- [Édition anglaise complète — vue d'ensemble du produit](../en/README.md)
- [Guide de démarrage rapide (anglais)](../en/getting-started.md)
- [Présentation du produit (anglais)](../en/product-introduction.md)
- [Gouvernance i18n et niveaux de langue](../README.md)

---

*Cette page est une synthèse Tier-2 à traduction assistée par machine. En cas d'écart, le texte chinois original prévaut ; l'édition anglaise complète sert de référence internationale.*
