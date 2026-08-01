# Runespeech — o idioma mágico do Destruitor

Substitui 100% das palavras mágicas da CipSoft (exura/exori/utevo...). Criado em 2026-08-01.
A estrutura é a mesma do original (verbo + modificadores), então cada magia continua com
palavras únicas — mas nenhum termo é o da CipSoft.

**Regra de manutenção:** toda magia nova usa APENAS raízes desta tabela (ou adiciona a raiz
nova aqui). O mapeamento foi aplicado no servidor (`:words("...")` nos scripts Lua) e no
cliente (`modules/gamelib/spells.lua`). A raiz `test` ficou igual de propósito (magia de dev).

## Exemplos
| Antes (CipSoft) | Agora (Destruitor) | Efeito |
|---|---|---|
| `exura` | `veyra` | cura leve |
| `exura vita` | `veyra liva` | cura suprema |
| `exori` | `korva` | golpe |
| `utevo lux` | `genva luma` | luz |
| `utani hur` | `sifra zefa` | velocidade |
| `adori flam` | `kruna pyra` | runa de fogo |

## Dicionário completo (raiz antiga → nova)
| CipSoft | Runespeech |
|---|---|
| `adana` | `zarna` |
| `adeta` | `tessra` |
| `adevo` | `fabra` |
| `adito` | `derra` |
| `adori` | `kruna` |
| `adura` | `vessra` |
| `alana` | `voska` |
| `aleta` | `senda` |
| `amp` | `ravo` |
| `ani` | `venna` |
| `blank` | `nulla` |
| `con` | `arca` |
| `dis` | `dista` |
| `dru` | `varn` |
| `eq` | `ekka` |
| `exana` | `seyla` |
| `exani` | `lemra` |
| `exeta` | `brakka` |
| `exevo` | `dorvan` |
| `exiva` | `trova` |
| `exori` | `korva` |
| `exura` | `veyra` |
| `flam` | `pyra` |
| `frigo` | `kryza` |
| `gran` | `mora` |
| `grav` | `felda` |
| `hur` | `zefa` |
| `ico` | `skarn` |
| `ina` | `nira` |
| `infir` | `novi` |
| `kor` | `krod` |
| `lux` | `luma` |
| `mas` | `kolo` |
| `max` | `prax` |
| `med` | `meda` |
| `min` | `lira` |
| `moe` | `myrra` |
| `mort` | `noxa` |
| `nia` | `nyla` |
| `pan` | `panna` |
| `pox` | `toxa` |
| `pug` | `fyst` |
| `res` | `fera` |
| `sac` | `sakra` |
| `san` | `solya` |
| `sio` | `syro` |
| `som` | `soma` |
| `tempo` | `tempra` |
| `tera` | `gorn` |
| `test` | `test` |
| `tio` | `tyro` |
| `ulus` | `ulmo` |
| `utamo` | `warda` |
| `utana` | `mirva` |
| `utani` | `sifra` |
| `uteta` | `kenva` |
| `utevo` | `genva` |
| `utito` | `morfa` |
| `utori` | `malva` |
| `utura` | `renva` |
| `ven` | `vexa` |
| `vid` | `veila` |
| `virtu` | `virta` |
| `vis` | `zolt` |
| `vita` | `liva` |
