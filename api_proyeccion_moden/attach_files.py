import os
import django
from django.core.files import File
from api.models import Planta

def run():
    # 1. Get first Planta
    planta = Planta.objects.first()
    if not planta:
        print("No Planta found. Please create a Project and Planta first.")
        return

    print(f"Updating Planta: {planta}")

    # 2. Paths
    pdf_path = r"C:\Users\LeyanisLopez\workspace\2025-07-10_DERIO MODULOS (A1-B1-C1-A2-B2-C2) - PLANOS A4.pdf"
    img_path = r"C:\Users\LeyanisLopez\.gemini\antigravity\brain\04c7f8dc-4546-4e31-a213-ca8831a76908\uploaded_media_1769509906398.jpg"

    # 3. Attach PDF
    if os.path.exists(pdf_path):
        with open(pdf_path, 'rb') as f:
            planta.fichero_corte.save('test_corte.pdf', File(f), save=False)
            print(f"Attached PDF: {pdf_path}")
    else:
        print(f"PDF not found: {pdf_path}")

    # 4. Attach Image
    if os.path.exists(img_path):
        with open(img_path, 'rb') as f:
            planta.plano_imagen.save('test_plano.jpg', File(f), save=False)
            print(f"Attached Image: {img_path}")
    else:
        print(f"Image not found: {img_path}")

    # 5. Save
    planta.save()
    print("Planta updated successfully.")

if __name__ == '__main__':
    run()
