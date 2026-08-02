import glob, os
import folha_sprites as fs
n = len(glob.glob(f"{fs.ASSETS}/*.original"))
print(n, "folhas alteradas")
