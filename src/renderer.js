export function renderDocument({ context, width, height, backgroundImage, figures, showHandles = false, transparent = false, drawFigure }) {
  if (transparent) context.clearRect(0, 0, width, height);
  else {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    if (backgroundImage) context.drawImage(backgroundImage, 0, 0, width, height);
  }
  figures.forEach(figure => {
    figure.updatePositions();
    drawFigure(figure, showHandles);
  });
}
