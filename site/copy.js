const button = document.getElementById('copy');
const statusMessage = document.getElementById('status');
if (navigator.clipboard?.writeText) {
  button.hidden = false;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(document.getElementById('command').textContent);
      statusMessage.textContent = 'Copied';
    } catch {
      statusMessage.textContent = 'Select the command to copy it.';
    }
  });
}
