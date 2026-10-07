Set-Location $PSScriptRoot
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = "Aagomoni Sur - Local Admin Passcode"
$form.StartPosition = "CenterScreen"
$form.Size = New-Object System.Drawing.Size(440, 185)
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$label = New-Object System.Windows.Forms.Label
$label.Text = "Enter the local server admin passcode:"
$label.Location = New-Object System.Drawing.Point(18, 18)
$label.Size = New-Object System.Drawing.Size(390, 24)
$passcodeBox = New-Object System.Windows.Forms.TextBox
$passcodeBox.Location = New-Object System.Drawing.Point(18, 48)
$passcodeBox.Size = New-Object System.Drawing.Size(390, 25)
$passcodeBox.UseSystemPasswordChar = $true
$okButton = New-Object System.Windows.Forms.Button
$okButton.Text = "Start server"
$okButton.Location = New-Object System.Drawing.Point(210, 88)
$okButton.Size = New-Object System.Drawing.Size(125, 32)
$okButton.DialogResult = [System.Windows.Forms.DialogResult]::OK
$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Text = "Cancel"
$cancelButton.Location = New-Object System.Drawing.Point(343, 88)
$cancelButton.Size = New-Object System.Drawing.Size(65, 32)
$cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.AddRange(@($label, $passcodeBox, $okButton, $cancelButton))
$form.AcceptButton = $okButton
$form.CancelButton = $cancelButton
$dialogResult = $form.ShowDialog()
if ($dialogResult -ne [System.Windows.Forms.DialogResult]::OK -or [string]::IsNullOrWhiteSpace($passcodeBox.Text)) {
    $form.Dispose()
    Write-Error "Server startup cancelled: an admin passcode is required."
    exit 1
}
$securePasscode = ConvertTo-SecureString $passcodeBox.Text -AsPlainText -Force
$passcodeBox.Clear()
$form.Dispose()
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePasscode)
$nodeExitCode = 0
try {
    $env:ADMIN_PASSCODE = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    node (Join-Path $PSScriptRoot "server.mjs")
    $nodeExitCode = $LASTEXITCODE
}
finally {
    Remove-Item Env:ADMIN_PASSCODE -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
exit $nodeExitCode
