# Guia de estilo de sprites do Destruitor

Resumo do tutorial do Galiant (fóruns TibiaBR, thread 243060), trazido pelo
Julio em 01/08/2026. É a referência oficial para gerar e retocar as sprites
próprias que vão substituir as da CipSoft.

## Regras de ouro (usar em TODO prompt de geração)

1. **Luz principal do noroeste** — topo e esquerda mais claros, baixo e
   direita mais escuros.
2. **Sudeste mais escuro, mas nunca preto puro** — sempre há luz indireta.
3. **Pixel a pixel** — sem blur, sem gradientes automáticos, sem anti-alias
   externo.
4. **Materiais refletem diferente** — metal polido: contraste e reflexo
   forte; tecido: transição suave; pedra bruta: manchas irregulares; madeira
   velha: quase sem reflexo; ouro: amarelos/laranjas com brilho concentrado.
5. **Silhueta reconhecível antes da pintura** — se não lê no tamanho
   original, não adianta detalhar.
6. **Perspectiva diagonal (~45°)** — a base do objeto encaixa no tile;
   objetos altos crescem para cima sem mudar a base.
7. **Contorno escuro, não necessariamente preto** — verde/marrom/cinza bem
   escuro fica mais natural que preto puro.
8. **Poucos tons bem escolhidos** — família de cores relacionadas, não uma
   clara + uma escura.
9. **Legível no tamanho original** — conferir sempre em 32x32 real, não só
   ampliado.
10. **Anti-aliasing manual só DENTRO da silhueta** — pixels intermediários
    internos; suavização externa quebra a transparência no jogo.

## Tamanhos

| Categoria                                  | Base          |
| ------------------------------------------ | ------------- |
| Itens carregáveis                          | 32x32         |
| Outfits e criaturas humanoides             | 32x32 de base |
| Objetos grandes (pedras, mesas, estátuas)  | 64x64 de base |

Objetos altos podem ultrapassar visualmente a área, mantendo a base no tile.

## Processo (itens/objetos)

1. **Silhueta** — contorno escuro, forma reconhecível.
2. **Formato interno** — dividir materiais (lâmina/guarda/cabo etc.) com
   tons bem escuros, sem preencher tudo de preto.
3. **Pintura básica** — testar paleta e leitura.
4. **Aprimoramento** — materiais, joias, rachaduras, cavidades, luz fina.

## Receitas específicas

- **Espada**: linha central diagonal na lâmina (tons da mesma família);
  lado noroeste e ponta mais claros, escurecendo em direção ao cabo; secção
  transversal mais escura marca a mudança de plano; bordas com pixels
  clareados para sugerir fio.
- **Joia**: mini esfera — ponto de luz forte no noroeste, reflexo secundário
  discreto no sudeste, tons intermediários de refração, encaixe escuro.
- **Cavidade**: borda externa iluminada, interior escuro com baixo
  contraste, borda secundária fraca, objeto interno parcialmente iluminado.
- **Rachadura**: linha central escura com ramificações irregulares; lado
  noroeste escuro, lado sudeste claro (dá profundidade); variar largura,
  direção e comprimento.
- **Esferas de cor (oficina de pintura)**: para cada material, montar uma
  esfera-referência com a rampa do tom mais escuro ao mais claro e capturar
  com conta-gotas na hora de pintar.

## Como isso entra no nosso pipeline

- Os prompts de folha 4x4 (ChatGPT) já pedem luz do noroeste e paleta
  fechada — manter e citar as regras 1-3 e 8 explicitamente.
- Pós-processamento (`ot-tools/art/fatiar_*.py`) cuida de 32x32 + paleta
  quantizada; o que a IA não acerta (secção de lâmina, joias, cavidades) é
  retoque manual em Aseprite/LibreSprite/Piskel seguindo as receitas acima.
- O tutorial não cobre criaturas/outfits (seção ficou reservada no fórum);
  para esses vamos definir nosso próprio processo quando chegar a hora.
