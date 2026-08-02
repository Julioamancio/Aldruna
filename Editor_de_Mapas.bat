@echo off
rem === Editor de Mapas do Destruitor ===
rem
rem Abre o editor no navegador. Cada "Salvar e publicar" grava o mapa, manda
rem para a VPS e reinicia o servidor do jogo - o que voce desenhou entra em
rem jogo em cerca de um minuto.
rem
rem Endereco: http://127.0.0.1:8090
rem
rem Para trabalhar sem mexer na VPS, use Editor_de_Mapas_local.bat.
rem
rem Atalhos dentro do editor:
rem   B pincel · G balde · E borracha · I conta-gotas
rem   Ctrl+Z desfazer · Ctrl+Y refazer · Ctrl+S salvar
rem   PageUp/PageDown troca de andar · roda do mouse da zoom
rem   Shift+arrastar (ou botao do meio) move a camera

cd /d "%~dp0ot-tools\mapa"
python servidor.py --publicar
pause
