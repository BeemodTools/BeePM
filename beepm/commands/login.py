"""GitHub OAuth login for BeePM"""

import os
import json
import secrets
import webbrowser
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlencode, parse_qs, urlparse

import click
import requests
from dotenv import load_dotenv, find_dotenv

# Load environment variables from .env file
# Try to find .env in current directory, parent directories, or project root
dotenv_path = find_dotenv(usecwd=True)
if dotenv_path:
    load_dotenv(dotenv_path)
else:
    # Try loading from current directory
    load_dotenv()


def get_beepm_paths():
    """Get BeePM directory paths"""
    appdata = Path(os.environ.get("APPDATA", ""))
    beepm_root = appdata / "beepm"
    
    return {
        "root": beepm_root,
        "config": beepm_root / "config",
        "auth_file": beepm_root / "config" / "auth.json"
    }


class OAuthCallbackHandler(BaseHTTPRequestHandler):
    """Handle OAuth callback from GitHub"""
    
    def log_message(self, format, *args):
        """Suppress default logging"""
        pass
    
    def do_GET(self):
        """Handle GET request from OAuth callback"""
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        
        # Extract code and state from callback
        self.server.oauth_code = params.get('code', [None])[0]
        self.server.oauth_state = params.get('state', [None])[0]
        self.server.oauth_error = params.get('error', [None])[0]
        
        # Send response to browser
        if self.server.oauth_error:
            self.send_response(400)
            self.send_header('Content-type', 'text/html')
            self.end_headers()
            self.wfile.write(b'''
                <html>
                <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
                    <h1 style="color: #d32f2f;">Authentication Failed</h1>
                    <p>You can close this window and return to the terminal.</p>
                </body>
                </html>
            ''')
        elif self.server.oauth_code:
            self.send_response(200)
            self.send_header('Content-type', 'text/html')
            self.end_headers()
            self.wfile.write(b'''
                <html>
                <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
                    <h1 style="color: #4caf50;">Authentication Successful!</h1>
                    <p>You can close this window and return to the terminal.</p>
                </body>
                </html>
            ''')
        else:
            self.send_response(400)
            self.send_header('Content-type', 'text/html')
            self.end_headers()
            self.wfile.write(b'''
                <html>
                <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
                    <h1 style="color: #d32f2f;">Invalid Request</h1>
                    <p>You can close this window and return to the terminal.</p>
                </body>
                </html>
            ''')


def exchange_code_for_token(code, client_id, client_secret):
    """Exchange authorization code for access token"""
    try:
        response = requests.post(
            'https://github.com/login/oauth/access_token',
            data={
                'client_id': client_id,
                'client_secret': client_secret,
                'code': code
            },
            headers={'Accept': 'application/json'},
            timeout=10
        )
        response.raise_for_status()
        
        data = response.json()
        if 'access_token' in data:
            return data['access_token']
        else:
            error = data.get('error_description', 'Unknown error')
            raise Exception(f"Token exchange failed: {error}")
            
    except requests.RequestException as e:
        raise Exception(f"Network error during token exchange: {str(e)}")


def get_github_user(token):
    """Get GitHub username using access token"""
    try:
        response = requests.get(
            'https://api.github.com/user',
            headers={
                'Authorization': f'Bearer {token}',
                'Accept': 'application/vnd.github.v3+json'
            },
            timeout=10
        )
        response.raise_for_status()
        
        data = response.json()
        return data.get('login')
        
    except requests.RequestException as e:
        raise Exception(f"Failed to get GitHub user: {str(e)}")


@click.command()
def login():
    """Login to BeePM using GitHub OAuth
    
    This command will open your browser to authenticate with GitHub.
    Your access token will be stored securely in %APPDATA%/beepm/config/auth.json
    """
    # Get GitHub OAuth credentials from environment
    client_id = os.environ.get('BEEPM_GITHUB_CLIENT_ID')
    client_secret = os.environ.get('BEEPM_GITHUB_CLIENT_SECRET')
    
    if not client_id or not client_secret:
        click.echo(click.style(
            "Error: GitHub OAuth credentials not configured.", 
            fg="red", 
            bold=True
        ))
        click.echo("Please set BEEPM_GITHUB_CLIENT_ID and BEEPM_GITHUB_CLIENT_SECRET environment variables.")
        raise click.Abort()
    
    # Generate random state for CSRF protection
    state = secrets.token_urlsafe(32)
    
    # Build OAuth authorization URL
    auth_params = {
        'client_id': client_id,
        'redirect_uri': 'http://localhost:8080/callback',
        'scope': 'read:user',
        'state': state
    }
    auth_url = f"https://github.com/login/oauth/authorize?{urlencode(auth_params)}"
    
    click.echo(click.style("\n🔐 BeePM Login", fg="cyan", bold=True))
    click.echo("Opening your browser for GitHub authentication...\n")
    
    # Open browser
    try:
        webbrowser.open(auth_url)
    except Exception as e:
        click.echo(click.style(f"Failed to open browser: {e}", fg="yellow"))
        click.echo(f"\nPlease manually open this URL:\n{auth_url}\n")
    
    # Start local server to receive callback
    click.echo("Waiting for authentication callback...")
    
    try:
        server = HTTPServer(('localhost', 8080), OAuthCallbackHandler)
        server.oauth_code = None
        server.oauth_state = None
        server.oauth_error = None
        
        # Wait for one request
        server.handle_request()
        
        # Check for errors
        if server.oauth_error:
            error_desc = server.oauth_error
            click.echo(click.style(f"\n❌ Authentication cancelled: {error_desc}", fg="red", bold=True))
            raise click.Abort()
        
        if not server.oauth_code or not server.oauth_state:
            click.echo(click.style("\n❌ Invalid callback received", fg="red", bold=True))
            raise click.Abort()
        
        # Verify state matches
        if server.oauth_state != state:
            click.echo(click.style("\n❌ Security error: State mismatch (possible CSRF attack)", fg="red", bold=True))
            raise click.Abort()
        
        click.echo(click.style("✓ Callback received", fg="green"))
        
        # Exchange code for token
        click.echo("Exchanging code for access token...")
        token = exchange_code_for_token(server.oauth_code, client_id, client_secret)
        click.echo(click.style("✓ Access token obtained", fg="green"))
        
        # Get GitHub username
        click.echo("Fetching GitHub username...")
        username = get_github_user(token)
        
        if not username:
            click.echo(click.style("\n❌ Failed to retrieve GitHub username", fg="red", bold=True))
            raise click.Abort()
        
        click.echo(click.style(f"✓ Authenticated as: {username}", fg="green"))
        
        # Save auth data
        paths = get_beepm_paths()
        paths['config'].mkdir(parents=True, exist_ok=True)
        
        auth_data = {
            'token': token,
            'username': username
        }
        
        with open(paths['auth_file'], 'w') as f:
            json.dump(auth_data, f, indent=2)
        
        click.echo(click.style(f"\n✓ Login successful! Credentials saved to {paths['auth_file']}", fg="green", bold=True))
        
    except KeyboardInterrupt:
        click.echo(click.style("\n\n❌ Login cancelled by user", fg="yellow"))
        raise click.Abort()
    except Exception as e:
        click.echo(click.style(f"\n❌ Login failed: {str(e)}", fg="red", bold=True))
        raise click.Abort()


if __name__ == "__main__":
    login()

