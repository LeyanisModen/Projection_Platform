
import os

models_path = r'c:\Users\LeyanisLopez\workspace\proyection_platform\api_proyeccion_moden\api\models.py'

with open(models_path, 'r', encoding='utf-8') as f:
    content = f.read()

if 'class UserProfile' not in content:
    # Append UserProfile model at the end or before Queue models? 
    # Let's put it after Core Models.
    
    # Locate end of Modulo or Imagen model
    insertion_point = content.find('# =============================================================================\n# QUEUE MODELS')
    
    if insertion_point == -1:
        insertion_point = len(content)
        
    new_model = """
class UserProfile(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='profile')
    telefono = models.CharField(max_length=20, blank=True, null=True)

    def __str__(self):
        return f"Perfil de {self.user.username}"

    class Meta:
        db_table = 'api_userprofile'

"""
    new_content = content[:insertion_point] + new_model + content[insertion_point:]
    
    with open(models_path, 'w', encoding='utf-8') as f:
        f.write(new_content)
    print("UserProfile added.")
else:
    print("UserProfile already exists.")
