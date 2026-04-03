import os
import requests
import json

def update_job_status_to_ui(job_id: str, status: str, info: str = None):
    ui_url = os.getenv("AITK_UI_URL", "http://localhost:8675")
    if not job_id:
        print("AITK_JOB_ID not found in environment, cannot update UI status.")
        return

    try:
        # Construct the URL for the status update endpoint
        url = f"{ui_url}/api/jobs/{job_id}/update_status"
        headers = {"Content-Type": "application/json"}
        payload = {"status": status, "info": info}

        response = requests.post(url, headers=headers, data=json.dumps(payload))
        response.raise_for_status()  # Raise an exception for HTTP errors
        print(f"Successfully updated job {job_id} status to '{status}' in UI.")
    except requests.exceptions.ConnectionError:
        print(f"Could not connect to UI at {ui_url}. Is the UI server running?")
    except requests.exceptions.RequestException as e:
        print(f"Error updating job status to UI: {e}")
    except Exception as e:
        print(f"An unexpected error occurred while updating job status to UI: {e}")

