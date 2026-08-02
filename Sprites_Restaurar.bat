@echo off
rem === Devolve os sprites do cliente ao estado de fabrica ===
rem
rem Usa os backups .original de cada folha alterada. Sua arte em
rem art_raw\nossos\ NAO e apagada - para reaplicar, rode Sprites_Aplicar.bat.
rem
rem Se algo ficar muito errado, existe ainda o retrato completo em
rem ot\backup-assets-1511-intacto (127 MB): copie o conteudo dele por cima de
rem ot\src1\otclient-4.1\data\things\1511

echo Restaurando os sprites originais do cliente...
echo.
wsl -d Ubuntu-24.04 -u root -- bash -c "cd /mnt/c/Users/julio/Aldruna/ot-tools/art && python3 trocar_chao.py --restaurar"
echo.
echo Pronto. Feche e abra o jogo.
pause
