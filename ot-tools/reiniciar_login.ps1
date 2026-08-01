# Mata qualquer login server antigo e sobe exatamente um.
# Copias antigas conseguem ligar na mesma porta no Windows e mandam o cliente
# para a porta errada -> "ERRO 10054" intermitente ao entrar no mundo.

$antigos = Get-CimInstance Win32_Process -Filter "Name LIKE 'python%'" |
    Where-Object { $_.CommandLine -like '*login_server.py*' }

foreach ($p in $antigos) {
    Write-Host "Encerrando login server antigo (PID $($p.ProcessId))..."
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
if ($antigos) { Start-Sleep -Seconds 2 }

Start-Process python -ArgumentList '"C:\Users\julio\Aldruna\ot-tools\login_server.py"' -WindowStyle Minimized
Start-Sleep -Seconds 3

$listeners = @(Get-NetTCPConnection -State Listen -LocalPort 8080 -ErrorAction SilentlyContinue)
if ($listeners.Count -eq 1) {
    Write-Host "Login server no ar (1 instancia)."
} else {
    Write-Host "ATENCAO: $($listeners.Count) instancias na porta 8080 - esperado 1."
}
