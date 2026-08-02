@echo off
rem === Assets Editor - editor de sprites do cliente ===
rem
rem Assets Folder (cole quando ele pedir):
rem   C:\Users\julio\Aldruna\ot\src1\otclient-4.1\data\things\1511
rem
rem Backup de fabrica, intacto: ot\backup-assets-1511-intacto
rem Para voltar tudo ao original, copie o conteudo do backup por cima da pasta
rem acima.
rem
rem O guia de o-que-trocar esta em docs\importar-no-assets-editor.md

echo Abrindo o Assets Editor...
echo Assets Folder: C:\Users\julio\Aldruna\ot\src1\otclient-4.1\data\things\1511
echo (o caminho tambem foi copiado para a area de transferencia)
powershell -NoProfile -Command "Set-Clipboard -Value 'C:\Users\julio\Aldruna\ot\src1\otclient-4.1\data\things\1511'"
cd /d "%~dp0ferramentas\AssetsEditor"
start "" "Assets Editor.exe"
