# Hook live « Jev tap » — design (étape 2b, PAS ENCORE INSTALLÉ)

> ⚠️ **SUPERSÉDÉ (17/09)** : l'intégration réelle est passée par le mécanisme
> officiel « generic provider » du Codex Router (`--adapter openai-responses`)
> + `server/jev_server.py`. Voir `server/INSTALL.md`. Ce dossier reste comme
> trace de l'exploration (approche callback LiteLLM écartée : `litellm.yaml`
> est régénéré par le router, toute modif serait écrasée).

## Principe

Un tap **fail-open, file-only** dans le gateway LiteLLM du Codex Router :

1. `async_pre_call_hook` → écrit une ligne JSONL locale (aucun réseau, aucune attente bloquante longue,
   toute exception avalée → le router ne casse JAMAIS un tour).
2. Un analyseur hors-bande (déjà écrit : `poc/shadow_replay.py`, variante à venir `--source tap`)
   consomme `jev-tap.jsonl`, appelle Jev, compare → `shadow-log.jsonl`.

**Pourquoi file-only :** l'appel Jev ne doit jamais se trouver sur le chemin critique d'une requête.
Si Jev tombe, si TypeSafe est lent, si la clé manque → le tap écrit quand même (ou pas) et Codex continue.

## Où ça se branche

- Callback : `~/.codex/codex-router/jev_tap_callback.py` (à côté de `grok_service_tier_callback.py`)
- Enregistrement : `litellm.yaml` → `callbacks: [..., jev_tap_callback.jev_tap_callback]`

⚠️ **Risques à gérer avant install :**
- `litellm.yaml` peut être régénéré par une mise à jour du router → prévoir de re-poser la ligne
  après chaque update (documenter ici, vérifier avec `router status`).
- Le gateway tourne en service (launchd) → après modification : redémarrage du service router.
- Le callback ne doit JAMAIS raise : tout est enveloppé `try/except: pass`.

## Données écrites (prefixe minimal, pas de secret)

```json
{"at": "...", "model": "gpt-5.6-astra", "call_type": "acompletion", "stream": true,
 "n_messages": 3, "last_user": "…600 chars max…", "source": "jev-tap"}
```

## Prochaine étape (exploration)

1. Install callback + ligne yaml → restart router.
2. `shadow_replay.py --source tap` : les vraies requêtes du gateway nourrissent le shadow.
3. Calibrer le gate de confiance (0.5 → ajuster) sur données réelles.
4. Ensuite seulement : mode actif (le routeur APPLIQUE la route Jev), d'abord sur les tours `apply`,
   avec kill-switch (env `JEV_ROUTER=off`).
