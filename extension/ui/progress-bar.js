import St from 'gi://St';

export class ProgressBar {
    constructor() {
        this.percent = 0;
        this.area = new St.DrawingArea({
            style_class: 'saveme-progress',
            x_expand: true,
        });
        this.area.connect('repaint', () => this._draw());
    }

    setPercent(value) {
        this.percent = Math.max(0, Math.min(100, Number(value) || 0));
        this.area.queue_repaint();
    }

    _draw() {
        const cr = this.area.get_context();
        const [width, height] = this.area.get_surface_size();
        cr.setSourceRGBA(1, 1, 1, 0.14);
        cr.rectangle(0, 0, width, height);
        cr.fill();
        if (this.percent > 0) {
            cr.setSourceRGBA(0.26, 0.52, 0.89, 1);
            cr.rectangle(0, 0, width * this.percent / 100, height);
            cr.fill();
        }
    }
}
