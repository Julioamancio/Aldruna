@echo off
rem === Editor de Mapas do Destruitor (so local) ===
rem
rem Igual ao Editor_de_Mapas.bat, mas Salvar apenas grava o .otbm no disco:
rem nao envia para a VPS nem reinicia o servidor do jogo.
rem
rem Bom para desenhar em paz sem derrubar quem estiver jogando.
rem
rem Endereco: http://127.0.0.1:8090

cd /d "%~dp0ot-tools\mapa"
python servidor.py
pause
