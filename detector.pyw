import cv2
import numpy as np

def get_limits(color):
    # Vibrant colors tuning to reject background noise (like wood/plants)
    
        
    # Orange - Raised S/V to 180 to avoid rust/oxide tones
    if color == 'orange':
        lowerLimit = np.array([5, 180, 180], dtype=np.uint8)
        upperLimit = np.array([20, 255, 255], dtype=np.uint8)

    # Yellow - Raised S/V to 180, upper S capped at 150 for lighter yellows
    elif color == 'yellow':
        lowerLimit = np.array([22, 180, 180], dtype=np.uint8)
        upperLimit = np.array([30, 150, 255], dtype=np.uint8)

    # Green - Raised S/V from 100 to 130 to avoid dark olive tones
    elif color == 'green':
        lowerLimit = np.array([40, 130, 130], dtype=np.uint8)
        upperLimit = np.array([85, 255, 255], dtype=np.uint8)

    # Blue/Cyan - Raised S from 80 to 120, V from 100 to 130
    elif color == 'blue':
        lowerLimit = np.array([90, 120, 130], dtype=np.uint8)
        upperLimit = np.array([125, 255, 255], dtype=np.uint8)

    # Purple/Violet - Raised S from 40 to 100, V from 50 to 100
    elif color == 'purple':
        lowerLimit = np.array([125, 100, 100], dtype=np.uint8)
        upperLimit = np.array([145, 255, 255], dtype=np.uint8)

    # Pink/Magenta - Raised S from 20 to 60, V from 130 to 150
    elif color == 'pink':
        lowerLimit = np.array([140, 60, 150], dtype=np.uint8)
        upperLimit = np.array([179, 120, 255], dtype=np.uint8)

    else:
        lowerLimit = np.array([0, 0, 0], dtype=np.uint8)
        upperLimit = np.array([0, 0, 0], dtype=np.uint8)
        
    return lowerLimit, upperLimit

def main():
    cap = cv2.VideoCapture(0)
    
    # Force 4K resolution to capture details at 3 meters
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 3840)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 2160)

    colors_to_detect = ['pink', 'green', 'blue', 'yellow', 'orange', 'purple']
    
    # Minimum area roughly scaled for 8x17cm cards at 3 meters in 4K resolution
    # Decreased to 3000 as requested
    min_area = 3000
    
    # Maximum area added to prevent excessively large detections. 
    # Starts at 500,000 for tuning.
    max_area = 8000

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        blurred = cv2.GaussianBlur(hsv, (5, 5), 0)

        for color_name in colors_to_detect:
            lower, upper = get_limits(color_name)
            mask = cv2.inRange(blurred, lower, upper)
            
            pass # No wrap-around needed as Pink doesn't cross the 0 boundary and Red is removed.

            # Morphological noise reduction
            kernel = np.ones((5, 5), np.uint8)
            mask = cv2.erode(mask, kernel, iterations=1) 
            mask = cv2.dilate(mask, kernel, iterations=2)

            contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

            for cnt in contours:
                area = cv2.contourArea(cnt)
                
                if min_area < area < max_area:
                    # Solidity check: To reject complex blobs (like plants, wood artifacts)
                    hull = cv2.convexHull(cnt)
                    hull_area = cv2.contourArea(hull)
                    
                    if hull_area > 0:
                        solidity = float(area) / hull_area
                        
                        # High solidity means it's a solid block (rectangle/circle). 
                        # The card is 8x17cm with a 4x4cm hole, which gives a solidity of ~0.88.
                        # So filtering > 0.65 will ignore very "noisy / spider-leg" shapes.
                        if solidity > 0.65:
                            x, y, w, h = cv2.boundingRect(cnt)
                            aspect_ratio = float(w)/h
                            
                            # A card of 8x17cm has AR ~2.1 or ~0.47 depending on rotation.
                            # The hole might skew it slightly, but it's never a perfect square.
                            # By rejecting aspect ratios near 1.0 (squares), we eliminate most background noise.
                            if (0.3 < aspect_ratio < 0.85) or (1.15 < aspect_ratio < 3.5): 
                                
                                # Calculate BBox density: How much of the BBox is actually the detected color
                                bbox_area = w * h
                                bbox_density = (area / bbox_area) * 100 if bbox_area > 0 else 0
                                
                                if bbox_density >= 70.0:
                                    # Draw thick rectangle around the detected card
                                    cv2.rectangle(frame, (x, y), (x + w, y + h), (0, 255, 0), 3)
                                    
                                    # Display color name
                                    label = f"{color_name.upper()} ({int(area)} px)"
                                    density_label = f"Densidad: {bbox_density:.1f}%"
                                    
                                    cv2.putText(frame, label, (x, y - 10), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 0), 3)
                                    cv2.putText(frame, density_label, (x, y + h + 30), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 0), 3)

        # Scale down for viewing on screen without losing the original frame resolution for detection
        display_frame = cv2.resize(frame, (1280, 720))
        cv2.imshow('Detector', display_frame)

        if cv2.waitKey(1) & 0xFF == ord('q'):
            break
        if cv2.getWindowProperty('Detector', cv2.WND_PROP_VISIBLE) < 1:
            break

    cap.release()
    cv2.destroyAllWindows()

if __name__ == "__main__":
    main()
