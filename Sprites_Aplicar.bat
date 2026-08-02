@echo off
rem === Manda a nossa arte para dentro do cliente ===
rem
rem Pega tudo que voce desenhou em art_raw\nossos\ (telas 32x32 com o numero
rem do sprite no nome) mais o de-para automatico de chao, e escreve nas folhas
rem do cliente. Nao mexe no que voce nao desenhou.
rem
rem Depois de rodar: feche e abra o jogo (o cliente guarda as folhas na memoria).
rem
rem Para saber o que desenhar: art_raw\nossos\_o_que_desenhar.md
rem Para voltar tudo ao original: Sprites_Restaurar.bat

echo Aplicando a nossa arte nos sprites do cliente...
echo.
wsl -d Ubuntu-24.04 -u root -- bash -c "cd /mnt/c/Users/julio/Aldruna/ot-tools/art && python3 sprites_editaveis.py importar"
echo.
echo Pronto. Feche e abra o jogo para ver.
pause
